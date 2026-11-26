-- LOCAL TEST ONLY: the parts of the existing app's schema supabase-finance.sql relies on
-- (Supabase roles + auth.uid() + the app's profiles table) and the security-hardening default.
\i supabase_shim.sql
create table if not exists public.profiles (
  id uuid primary key references auth.users(id), username text, name text,
  role text check (role in ('owner','senior','employee','kiosk')), emp_id text, pages text[], branch text,
  created_at timestamptz default now()
);
alter table public.profiles enable row level security;
-- same as supabase-security-hardening.sql: new functions are NOT executable by default
alter default privileges in schema public revoke execute on functions from public;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a','owner@t'), ('00000000-0000-0000-0000-00000000000b','owner2@t'),
  ('00000000-0000-0000-0000-00000000000c','senior@t'), ('00000000-0000-0000-0000-00000000000d','emp@t'),
  ('00000000-0000-0000-0000-00000000000e','kiosk@t') on conflict do nothing;
insert into public.profiles (id, username, name, role, emp_id, branch, pages) values
  ('00000000-0000-0000-0000-00000000000a','kareem','Owner','owner',null,'b1',null),
  ('00000000-0000-0000-0000-00000000000b','hassan','Owner 2','owner',null,'b1',null),
  -- a supervisor who has been given EVERY page, including anything named "finance"
  ('00000000-0000-0000-0000-00000000000c','mosamr','Senior','senior','EK002','b1', array['dashboard','payroll','settings','audit','fin_dashboard','finance']),
  ('00000000-0000-0000-0000-00000000000d','drmah','Emp','employee','EK001','b1',null),
  ('00000000-0000-0000-0000-00000000000e','kiosk','Kiosk','kiosk',null,'b1',null)
on conflict do nothing;
