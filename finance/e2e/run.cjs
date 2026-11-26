// LOCAL E2E: drives the real index.html (served by server.mjs) in Chromium.
// node run.cjs <screenshotDir>
const { chromium } = require('playwright');
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const BASE = 'http://localhost:54321/';
const OUT = process.argv[2] || '.';
const DATA = join(__dirname, '../data');
// private expected figures (finance/data/expected_extra.json – never committed)
const X = JSON.parse(readFileSync(join(DATA, 'expected_extra.json'), 'utf8')).e2e;
const results = [];
const ok = (name, cond, extra = '') => { results.push([cond ? '✔' : '✖', name, extra]); };

async function login(browser, user) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'مسح' : undefined));
  await page.goto(BASE);
  await page.fill('#login-user', user);
  await page.fill('#login-pass', 'local-harness');
  await page.click('#login-btn');
  await page.waitForSelector('.nav-item', { timeout: 30000 });
  return page;
}
const go = async (page, id) => { await page.click(`.nav-item[data-page="${id}"]`); await page.waitForTimeout(400); };
const waitText = (page, text, timeout = 60000) => page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });

(async () => {
  const browser = await chromium.launch();

  // ---------------------------------------------------------------- owner
  const o = await login(browser, 'kareem');
  const navText = await o.locator('.nav-item').allInnerTexts();
  ok('owner sees the finance section in the menu', navText.some((t) => t.includes('لوحة المالية')));
  await go(o, 'fin_settings');
  await waitText(o, 'لا توجد بيانات مالية بعد').catch(() => waitText(o, 'استيراد حزمة البيانات'));
  await o.click('[data-fin-pkg]');
  await o.setInputFiles('#fin-pkg-files', readdirSync(DATA).filter((f) => /\.(csv|json)$/.test(f) && f !== 'expected_results.json').map((f) => join(DATA, f)));
  await o.click('[data-fin-pkgread]');
  await waitText(o, 'ملخص الأرقام قبل الحفظ');
  const pre = await o.locator('.modal').innerText();
  ok('package preview shows YTD net result before saving', pre.includes(X.netResultPreviewText), pre.match(/صافي النتيجة YTD [\d,.()]+/)?.[0]);
  await o.click('[data-fin-pkgsave]');
  await waitText(o, 'تم استيراد بيانات المالية', 180000);
  await go(o, 'fin_dashboard');
  await waitText(o, 'لوحة المالية —');
  const dash = await o.locator('.fin').innerText();
  ok('dashboard YTD net sales as expected', dash.includes(X.netSalesText));
  // November salaries come from the app → the dashboard (report month Oct) is unchanged: YTD net result Jan–Oct
  ok('dashboard YTD net result as expected (Jan–Oct, Excel payroll)', dash.includes(X.netResultText));
  ok('link card shows the app sales for October (from app_schema.sql)', dash.includes('800,000'));
  await o.screenshot({ path: join(OUT, 'e2e-owner-dashboard.png'), fullPage: true });

  // checks
  await go(o, 'fin_checks');
  await waitText(o, 'اختبارات المطابقة');
  const checks = await o.locator('.fin').innerText();
  ok('checks: all pass with warnings', checks.includes('كل الاختبارات سليمة') && checks.includes('⚠ 2'), checks.match(/⚠ \d+ تنبيهات/)?.[0]);
  await o.screenshot({ path: join(OUT, 'e2e-owner-checks.png'), fullPage: true });

  // branch 1 → payroll → November (linked to the app's payroll page)
  await go(o, 'fin_branch');
  await o.click('[data-fin-tab="payroll"]');
  await o.click('[data-fin-paym="11"]');
  await waitText(o, 'كشف المرتبات من التطبيق');
  const pay = await o.locator('.fin').innerText();
  ok('November payroll is read from the app (3 employees + owners)', pay.includes('موظف أ (تجربة)') && pay.includes('موظف ب (تجربة)') && pay.includes('(Owner)'));
  await o.screenshot({ path: join(OUT, 'e2e-owner-payroll-nov-linked.png'), fullPage: true });
  // switch report month to November → P&L salaries = app payroll + owners
  await o.selectOption('#fin-rm', '11');
  await o.waitForTimeout(300);
  await o.click('[data-fin-tab="pl"]');
  await waitText(o, 'قائمة الدخل الشهرية');
  await o.screenshot({ path: join(OUT, 'e2e-owner-pl.png'), fullPage: true });

  // add an expense through the UI → audit log
  await o.click('[data-fin-tab="expenses"]');
  await o.click('[data-fin-add]');
  await o.fill('[data-fin-f="date"]', '2026-11-05');
  await o.fill('[data-fin-f="description"]', 'E2E test line');
  await o.selectOption('[data-fin-f="category_key"]', 'CLEAN');
  await o.fill('[data-fin-f="amount"]', '125.5');
  await o.click('[data-fin-rowsave]');
  await waitText(o, 'تم الحفظ');
  await o.waitForTimeout(1500);
  ok('expense added through the UI', (await o.locator('.fin').innerText()).includes('E2E test line'));
  await go(o, 'fin_audit');
  await waitText(o, 'E2E test line', 20000).then(() => ok('audit log shows the new expense', true)).catch(() => ok('audit log shows the new expense', false));

  // Excel export (in the browser)
  await go(o, 'fin_consolidated');
  await waitText(o, 'قائمة الدخل المجمعة');
  const [dl] = await Promise.all([o.waitForEvent('download', { timeout: 60000 }), o.click('[data-fin-export="consolidated"]')]);
  ok('consolidated P&L exports to .xlsx', /\.xlsx$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  await dl.saveAs(join(OUT, dl.suggestedFilename()));
  ok('no JavaScript errors (owner)', o.errors.length === 0, o.errors.slice(0, 3).join(' | '));

  // ---------------------------------------------------------------- supervisor & employee: nothing financial, anywhere
  for (const [user, label] of [['mosamr', 'supervisor'], ['drmah', 'employee']]) {
    const p = await login(browser, user);
    const nav = (await p.locator('.nav-item').allInnerTexts()).join(' ');
    ok(`${label}: no finance items in the menu`, !/المالية|لوحة المالية|قائمة الدخل/.test(nav));
    // try to open a finance page directly (as if the page id had been granted)
    await p.evaluate(() => { state.page = 'fin_dashboard'; render(); });
    await p.waitForTimeout(800);
    const txt = await p.locator('body').innerText();
    ok(`${label}: forcing a finance page shows only the lock`, !txt.includes(X.netSalesText) && !/صافي المبيعات/.test(txt) && txt.includes('للمالك فقط'));
    // query the database directly from the browser console with the user's own session
    const leak = await p.evaluate(async () => {
      const out = {};
      for (const t of ['fin_settings', 'fin_monthly_inputs', 'fin_expenses', 'fin_payroll_lines', 'fin_payroll_owner_lines', 'fin_audit']) {
        const { data, error } = await sb.from(t).select('*').limit(5);
        out[t] = error ? `denied` : data.length;
      }
      const ins = await sb.from('fin_expenses').insert({ branch_id: 1, fiscal_year: 2026, date: '2026-11-02', description: 'x', category_key: 'CLEAN', amount: 1 });
      out.insert = ins.error ? 'denied' : 'ALLOWED';
      const rst = await sb.rpc('fin_reset_data');
      out.reset = rst.error ? 'denied' : 'ALLOWED';
      return out;
    });
    ok(`${label}: direct database reads return 0 rows`, Object.entries(leak).filter(([k]) => k.startsWith('fin_')).every(([, v]) => v === 0 || v === 'denied'), JSON.stringify(leak));
    ok(`${label}: direct insert / reset refused`, leak.insert === 'denied' && leak.reset === 'denied');
    await p.screenshot({ path: join(OUT, `e2e-${label}-forced-finance-page.png`) });
    ok(`no JavaScript errors (${label})`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
  }

  await browser.close();
  for (const r of results) console.log(r[0], r[1], r[2] ? `— ${r[2]}` : '');
  const fails = results.filter((r) => r[0] === '✖').length;
  console.log(fails ? `\n✖ ${fails} failed` : `\n✔ all ${results.length} e2e checks passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); for (const r of results) console.log(r[0], r[1], r[2] || ''); process.exit(1); });
