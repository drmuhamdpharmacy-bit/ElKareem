// LOCAL E2E HARNESS ONLY — never deployed.
// Serves the real index.html / crm.js / finance.js against a local PostgreSQL by implementing the small
// subset of Supabase that supabase-js uses here:
//   /auth/v1/*  → password login issuing HS256 JWTs (like GoTrue)
//   /rest/v1/*  → a PostgREST-compatible adapter. EVERY request runs inside a transaction as the JWT's
//                 role ('authenticated' / 'anon') with request.jwt.claims set, so the real RLS policies decide.
// Usage: DATABASE_URL=postgres://… node server.mjs   (port 54321)
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1082, (v) => v);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../..');
const NM = join(HERE, '../node_modules');
const PORT = 54321;
const SECRET = 'local-e2e-secret';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ------------------------------------------------------------------ JWT (HS256)
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const sign = (payload) => {
  const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64(payload);
  return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
};
function verify(tok) {
  const [h, p, s] = String(tok || '').split('.');
  if (!s || createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url') !== s) return null;
  const c = JSON.parse(Buffer.from(p, 'base64url').toString());
  return c.exp && c.exp < Date.now() / 1000 ? null : c;
}
const ANON = sign({ role: 'anon', iss: 'e2e' });

// ------------------------------------------------------------------ helpers
const ID = /^[a-z_][a-z0-9_]*$/;
const ident = (x) => { if (!ID.test(x)) throw Object.assign(new Error(`bad identifier ${x}`), { status: 400 }); return `"${x}"`; };
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b ? JSON.parse(b) : null)); });

async function asRole(claims, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await c.query(`set local role ${claims.role === 'authenticated' ? 'authenticated' : 'anon'}`);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// PostgREST filters: col=op.value
function where(params, args) {
  const w = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
    const m = /^(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|in|is)\.(.*)$/s.exec(v);
    if (!m) continue;
    const [, not, op, raw] = m, col = ident(k);
    let sql;
    if (op === 'is') sql = `${col} is ${raw === 'null' ? 'null' : raw === 'true' ? 'true' : 'false'}`;
    else if (op === 'in') {
      const items = raw.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''));
      args.push(items); sql = `${col}::text = any($${args.length}::text[])`;
    } else {
      const sym = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike' }[op];
      args.push(op.endsWith('like') ? raw.replace(/\*/g, '%') : raw); sql = `${col} ${sym} $${args.length}`;
    }
    w.push(not ? `not (${sql})` : sql);
  }
  return w.length ? ` where ${w.join(' and ')}` : '';
}
const orderBy = (o) => (o ? ` order by ${o.split(',').map((x) => { const [c, dir, nulls] = x.split('.'); return `${ident(c)} ${dir === 'desc' ? 'desc' : 'asc'}${nulls ? ` ${nulls === 'nullsfirst' ? 'nulls first' : 'nulls last'}` : ''}`; }).join(', ')}` : '');
const selectCols = (s) => (!s || s === '*' ? '*' : s.split(',').map((c) => ident(c.trim())).join(', '));

async function pkOf(c, table) {
  const r = await c.query(`select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
                           where i.indrelid = $1::regclass and i.indisprimary`, [`public.${table}`]);
  return r.rows.map((x) => x.attname);
}

async function rest(req, res, url, claims) {
  const path = url.pathname.replace(/^\/rest\/v1\//, '');
  const P = url.searchParams, prefer = req.headers.prefer || '', single = /vnd\.pgrst\.object/.test(req.headers.accept || '');
  const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : null;
  const out = await asRole(claims, async (c) => {
    if (path.startsWith('rpc/')) {
      const fn = path.slice(4); ident(fn);
      const info = (await c.query(`select p.proretset, t.typname from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type t on t.oid = p.prorettype
                                    where n.nspname = 'public' and p.proname = $1 limit 1`, [fn])).rows[0];
      if (!info) throw Object.assign(new Error(`function ${fn} not found`), { status: 404 });
      const keys = Object.keys(body || {}), args = keys.map((k) => body[k]);
      const call = `public.${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')})`;
      if (info.proretset || info.typname === 'record') return (await c.query(`select * from ${call}`, args)).rows;
      const v = (await c.query(`select ${call} as v`, args)).rows[0].v;
      return info.typname === 'void' ? null : v;
    }
    const t = ident(path), args = [];
    if (req.method === 'GET') {
      let sql = `select ${selectCols(P.get('select'))} from public.${t}${where(P, args)}${orderBy(P.get('order'))}`;
      if (P.get('limit')) sql += ` limit ${Number(P.get('limit'))}`;
      if (P.get('offset')) sql += ` offset ${Number(P.get('offset'))}`;
      return (await c.query(sql, args)).rows;
    }
    if (req.method === 'POST') {
      const list = Array.isArray(body) ? body : [body];
      const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
      args.push(JSON.stringify(list));
      let sql = `insert into public.${t} (${cols.map(ident).join(', ')}) select ${cols.map(ident).join(', ')} from jsonb_populate_recordset(null::public.${t}, $1::jsonb)`;
      if (/resolution=merge-duplicates/.test(prefer)) {
        const conflict = P.get('on_conflict') ? P.get('on_conflict').split(',') : await pkOf(c, path);
        const upd = cols.filter((x) => !conflict.includes(x));
        sql += ` on conflict (${conflict.map(ident).join(', ')}) do ${upd.length ? `update set ${upd.map((x) => `${ident(x)} = excluded.${ident(x)}`).join(', ')}` : 'nothing'}`;
      }
      return (await c.query(`${sql} returning *`, args)).rows;
    }
    if (req.method === 'PATCH') {
      const cols = Object.keys(body);
      args.push(JSON.stringify(body));
      const sql = `update public.${t} set (${cols.map(ident).join(', ')}) = (select ${cols.map(ident).join(', ')} from jsonb_populate_record(null::public.${t}, $1::jsonb))${where(P, args)} returning *`;
      return (await c.query(cols.length === 1 ? sql.replace(/set \((.*?)\) = \(select (.*?) from/, 'set $1 = (select $2 from') : sql, args)).rows;
    }
    if (req.method === 'DELETE') return (await c.query(`delete from public.${t}${where(P, args)} returning *`, args)).rows;
    throw Object.assign(new Error('method'), { status: 405 });
  });
  if (path.startsWith('rpc/')) return send(res, 200, out);
  if (req.method !== 'GET' && !/return=representation/.test(prefer)) return send(res, 201, undefined);
  if (single) {
    if (out.length !== 1) return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `${out.length} rows`, hint: null });
    return send(res, 200, out[0]);
  }
  return send(res, req.method === 'POST' ? 201 : 200, out, { 'Content-Range': `0-${Math.max(0, out.length - 1)}/*` });
}

async function auth(req, res, url) {
  const p = url.pathname;
  if (p === '/auth/v1/token') {
    const b = await readBody(req);
    let user;
    if (url.searchParams.get('grant_type') === 'refresh_token') {
      const c = verify(b.refresh_token); if (!c) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
      user = (await pool.query(`select id, email from auth.users where id = $1`, [c.sub])).rows[0];
    } else {
      // local harness: any password works for the seeded users
      user = (await pool.query(`select id, email from auth.users where lower(email) = lower($1)`, [b.email])).rows[0];
    }
    if (!user) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const u = { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
    return send(res, 200, { access_token: sign({ sub: user.id, role: 'authenticated', aud: 'authenticated', email: user.email, exp }), token_type: 'bearer',
      expires_in: 3600, expires_at: exp, refresh_token: sign({ sub: user.id, typ: 'refresh', exp: exp + 86400 }), user: u });
  }
  if (p === '/auth/v1/user') {
    const c = verify((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!c || !c.sub) return send(res, 401, { message: 'invalid JWT' });
    return send(res, 200, { id: c.sub, aud: 'authenticated', role: 'authenticated', email: c.email, app_metadata: {}, user_metadata: {} });
  }
  if (p === '/auth/v1/logout') return send(res, 204, undefined);
  return send(res, 404, { message: 'not found' });
}

// ------------------------------------------------------------------ static files (real repo files, local URLs patched in)
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css', png: 'image/png', json: 'application/json' };
function staticFile(res, pathname) {
  const map = { '/vendor/supabase.js': join(NM, '@supabase/supabase-js/dist/umd/supabase.js'), '/vendor/exceljs.min.js': join(NM, 'exceljs/dist/exceljs.min.js') };
  const name = pathname === '/' ? '/index.html' : pathname;
  const file = map[name] || join(REPO, name.replace(/^\/+/, ''));
  if (!file.startsWith(REPO) && !map[name]) return send(res, 403, {});
  if (!existsSync(file) || (!map[name] && /\/finance\/(data|e2e|node_modules)/.test(file))) return send(res, 404, { message: 'not found' });
  let buf = readFileSync(file);
  if (name === '/index.html') {
    buf = Buffer.from(buf.toString()
      .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2/, '/vendor/supabase.js')
      .replace(/const SUPABASE_URL = '[^']+'/, `const SUPABASE_URL = 'http://localhost:${PORT}'`)
      .replace(/const SUPABASE_KEY = '[^']+'/, `const SUPABASE_KEY = '${ANON}'`));
  }
  if (name === '/finance.js') buf = Buffer.from(buf.toString().replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/exceljs@[^']+/, '/vendor/exceljs.min.js'));
  res.writeHead(200, { 'Content-Type': MIME[name.split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(buf);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,PUT,OPTIONS' });
    return res.end();
  }
  try {
    if (url.pathname.startsWith('/auth/v1/')) return await auth(req, res, url);
    if (url.pathname.startsWith('/rest/v1/')) {
      const claims = verify((req.headers.authorization || '').replace(/^Bearer /, '')) || { role: 'anon' };
      return await rest(req, res, url, claims);
    }
    if (url.pathname.startsWith('/realtime/') || url.pathname.startsWith('/storage/')) return send(res, 404, {});
    return staticFile(res, url.pathname);
  } catch (e) {
    const status = e.status || (e.code === '42501' ? 403 : e.code === 'P0001' ? 400 : 400);
    if (!process.env.QUIET) console.error(req.method, req.url, e.code, e.message);
    return send(res, status, { code: e.code || 'E2E', message: e.message, details: e.detail || null, hint: e.hint || null });
  }
}).listen(PORT, () => console.log(`e2e harness on http://localhost:${PORT}`));
