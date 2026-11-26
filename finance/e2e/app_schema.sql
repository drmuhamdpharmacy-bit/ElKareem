-- LOCAL E2E ONLY — a minimal stand-in for the existing app's Supabase schema (profiles, app_store, …)
-- so the real index.html can log in locally. The finance part (supabase-finance.sql) is applied unchanged on top.
\i ../sql-tests/supabase_shim.sql
create table if not exists public.profiles (id uuid primary key, username text unique, name text, role text, emp_id text, pages jsonb, branch text, created_at timestamptz default now());
create table if not exists public.app_store (id text primary key, data jsonb, updated_at timestamptz default now());
create table if not exists public.emp_view (emp_id text primary key, branch text, data jsonb, updated_at timestamptz default now());
create table if not exists public.checkins (id bigserial primary key, emp_id text, emp_name text, branch text, kind text, at timestamptz default now(), lat float8, lng float8, dist_m float8, user_id uuid, source text, note text);
create table if not exists public.fix_requests (id bigserial primary key, branch text, emp_id text, status text default 'pending', created_at timestamptz default now(), data jsonb);
create table if not exists public.leave_requests (id bigserial primary key, branch text, emp_id text, status text default 'pending', created_at timestamptz default now(), data jsonb);
create table if not exists public.audit_log (id bigserial primary key, at timestamptz default now(), data jsonb);
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
create or replace function public.app_version() returns int language sql as $$ select 3 $$;
create or replace function public.attendance_days(p_branch text, p_from timestamptz, p_to timestamptz, p_emp text default null)
  returns table(emp_id text, day date, first_in timestamptz, last_out timestamptz, minutes int, forgot int, fixed int, open int, forgot_in bigint)
  language sql as $$ select null::text, null::date, null::timestamptz, null::timestamptz, 0, 0, 0, 0, null::bigint where false $$;
grant execute on function public.app_version(), public.attendance_days(text, timestamptz, timestamptz, text) to authenticated;
-- same default as supabase-security-hardening.sql
alter default privileges in schema public revoke execute on functions from public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1','kareem@elkareem-staff.app'),
  ('00000000-0000-0000-0000-0000000000c1','mosamr@elkareem-staff.app'),
  ('00000000-0000-0000-0000-0000000000e1','drmah@elkareem-staff.app') on conflict do nothing;
insert into public.profiles (id, username, name, role, emp_id, pages, branch) values
  ('00000000-0000-0000-0000-0000000000a1','kareem','المالك (تجربة)','owner',null,'["dashboard","monthly","payroll","commission","employees","attendance","settings","audit"]','b1'),
  -- a supervisor ticked for every page, plus made-up finance page ids: must still see nothing financial
  ('00000000-0000-0000-0000-0000000000c1','mosamr','مشرف (تجربة)','senior','EK002','["dashboard","payroll","commission","attendance","missions","leaderboard","messages","shifts","leaves","kiosk","withdrawals","settings","audit","fin_dashboard","fin_consolidated"]','b1'),
  ('00000000-0000-0000-0000-0000000000e1','drmah','موظف (تجربة)','employee','EK001','["mycheckin","myperformance","mymissions","myattendance","mymessages","leaderboard","myleaves","fin_dashboard"]','b1')
on conflict do nothing;
insert into public.app_store (id, data) values
  ('branches', '[{"id":"b1","name":"الفرع 1"},{"id":"b2","name":"الفرع 2"}]'),
  ('b1/employees', '[{"id":"EK001","name":"صيدلي (تجربة)","role":"Pharmacist","hourRate":1000,"commPct":25,"shift":"صباحي"},
                     {"id":"EK002","name":"موظف أ (تجربة)","role":"Assistant","hourRate":520,"commPct":20,"shift":"صباحي"},
                     {"id":"EK006","name":"موظف ب (تجربة)","role":"Assistant","hourRate":480,"commPct":15,"shift":"مسائي"}]'),
  -- fiscal November 2026 = app month key "2026-10" (0-based month, 26 Oct → 25 Nov)
  ('b1/monthly_data', '{"2026-10":{"sales":950000,"gp":300000,"np":150000,"hours":{"EK001":100,"EK002":200,"EK006":180}},
                        "2026-9":{"sales":800000,"gp":250000,"np":120000,"hours":{"EK001":100,"EK002":200,"EK006":180}}}'),
  ('b1/bonuses', '{"2026-10":[{"empId":"EK002","name":"يوم عمل إضافي","amount":400}]}'),
  ('b1/penalties', '{}'),
  ('b1/withdrawals', '{"2026-10":[{"empId":"EK006","amount":250,"type":"مسحوبات أدوية"}]}'),
  ('b1/commission_tiers', '{"Q4":[{"min":841000,"rate":1},{"min":900000,"rate":1.5},{"min":960000,"rate":2}],"_v":2}'),
  ('b2/employees', '[{"id":"EK101","name":"موظف الفرع 2 (تجربة)","role":"Assistant","hourRate":400,"commPct":0,"shift":"صباحي"}]'),
  ('b2/monthly_data', '{"2026-10":{"sales":100000,"gp":30000,"np":5000,"hours":{"EK101":200}}}')
on conflict (id) do nothing;
