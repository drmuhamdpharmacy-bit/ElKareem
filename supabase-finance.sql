-- ════════════════════════════════════════════════════════════════════
--  صيدليات الكريم — المالية (Financial system) · Supabase → SQL Editor → Run
--  Safe to run more than once. It ONLY ADDS fin_* tables and fin_* functions;
--  nothing that already exists (employees, attendance, payroll, CRM, …) is changed.
--
--  WHO CAN SEE IT: owners only (profiles.role = 'owner').
--    Supervisors (senior), employees, kiosk and visitors get NOTHING — not even if a page is
--    ticked for them in Settings: the database itself refuses every row (row level security).
--
--  The financial figures are NOT in this file (the repository is public). After running it,
--  open the site as an owner → المالية → الإعدادات → «استيراد حزمة البيانات».
-- ════════════════════════════════════════════════════════════════════

-- ---------------------------------------------------------------- who is an owner
create or replace function public.fin_is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'owner')
$$;
revoke execute on function public.fin_is_owner() from public, anon;
grant execute on function public.fin_is_owner() to authenticated;

-- ---------------------------------------------------------------- settings & reference data
create table if not exists fin_settings (
  id            int primary key default 1 check (id = 1),
  name_ar       text not null default 'صيدليات الكريم',
  name_en       text not null default 'El Kareem Pharmacies',
  currency      text not null default 'EGP',
  current_year  int not null default 2026,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_years (
  year                             int primary key,
  start_day                        int not null default 26 check (start_day between 2 and 28),
  report_month                     int not null default 1 check (report_month between 1 and 12),
  lateness_auto_from_month         int not null default 11 check (lateness_auto_from_month between 1 and 13),
  lateness_half_day_from_minutes   int not null default 11,
  lateness_two_days_above_minutes  int not null default 30,
  lateness_day_hours               numeric(5,2) not null default 8,
  commission_tier_mode             text not null default 'original' check (commission_tier_mode in ('original','tier1_from_96pct_target')),
  bottom_line                      text not null default 'net_after_stock_losses' check (bottom_line in ('net_after_stock_losses','operating_result')),
  -- Salaries in the P&L come from the app's payroll page from this fiscal month on (null = never).
  app_payroll_from_month           int check (app_payroll_from_month between 1 and 12),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_branches (
  id          int primary key,
  name_ar     text not null,
  name_en     text not null,
  color       text not null default '#003392',
  app_branch  text,                -- the app's branch id (app_store 'branches': 'b1', 'b2', …) — links sales & payroll
  sort_order  int not null default 0,
  active      boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_branch_settings (
  branch_id                         int not null references fin_branches(id) on delete cascade,
  year                              int not null references fin_years(year) on delete cascade,
  depreciation_register_from_month  int not null default 1 check (depreciation_register_from_month between 1 and 13),
  opened_month                      int check (opened_month between 1 and 12),
  primary key (branch_id, year),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_expense_categories (
  key         text primary key check (key ~ '^[A-Z_]+$'),
  name_ar     text not null unique,
  name_en     text not null,
  pl_class    text not null check (pl_class in ('OPEX','STAFF','DEP')),
  sort_order  int not null default 0,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_asset_categories (
  id                  serial primary key,
  name                text not null unique,
  useful_life_months  int check (useful_life_months > 0),
  sort_order          int not null default 0,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_adjustment_reasons (
  id          serial primary key,
  name_ar     text not null unique,
  name_en     text,
  sort_order  int not null default 0,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);

-- ---------------------------------------------------------------- branch data (empty cells stay NULL, never 0)
create table if not exists fin_opening_balances (
  id bigserial primary key,
  branch_id int not null references fin_branches(id), year int not null references fin_years(year),
  inventory_value numeric(14,2), sku_count int, inventory_qty numeric(14,2),
  unique (branch_id, year),
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_monthly_inputs (
  id bigserial primary key,
  branch_id int not null references fin_branches(id), year int not null references fin_years(year),
  month int not null check (month between 1 and 12),
  gross_sales numeric(14,2), returns numeric(14,2), gross_profit numeric(14,2), invoices int, items_sold int,
  loyalty_points numeric(14,2), salaries_recorded_legacy numeric(14,2), purchases_gross numeric(14,2),
  purchase_returns numeric(14,2), inventory_end_value numeric(14,2), sku_end int, inventory_end_qty numeric(14,2), notes text,
  unique (branch_id, year, month),
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_expenses (
  id bigserial primary key,
  branch_id int not null references fin_branches(id), fiscal_year int not null references fin_years(year),
  date date, description text not null,
  category_key text references fin_expense_categories(key) on update cascade,
  amount numeric(14,2) not null, period_override int check (period_override between 1 and 12), source text,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);
create index if not exists fin_expenses_branch_year on fin_expenses (branch_id, fiscal_year);

create table if not exists fin_stock_adjustments (
  id bigserial primary key,
  branch_id int not null references fin_branches(id), year int not null references fin_years(year),
  month int not null check (month between 1 and 12),
  item_code text, item_name text, qty numeric(14,3), unit text, unit_cost numeric(16,5), manual_amount numeric(14,2),
  reason text references fin_adjustment_reasons(name_ar) on update cascade, source text,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_assets (
  id bigserial primary key,
  branch_id int not null references fin_branches(id),
  name text not null, cost numeric(14,2) not null,
  category text references fin_asset_categories(name) on update cascade,
  custom_months int check (custom_months > 0), date_added date, notes text,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_staff (
  id bigserial primary key,
  lateness_name text not null, payroll_name text not null, role text,
  app_emp_id text,                -- the app's employee code (EK001…) when known
  active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_staff_assignments (
  id bigserial primary key,
  staff_id bigint not null references fin_staff(id) on delete cascade,
  branch_id int not null references fin_branches(id), year int not null references fin_years(year),
  from_month int not null default 1 check (from_month between 1 and 12),
  unique (staff_id, year, from_month),
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_lateness (
  id bigserial primary key,
  branch_id int not null references fin_branches(id),
  date date not null, employee text not null, minutes_late int not null check (minutes_late >= 0), notes text,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_payroll_months (
  id bigserial primary key,
  branch_id int not null references fin_branches(id), year int not null references fin_years(year),
  month int not null check (month between 1 and 12),
  sales_for_commission numeric(14,2), target numeric(14,2),
  threshold_1pct numeric(14,2), threshold_1_5pct numeric(14,2), threshold_2pct numeric(14,2),
  unique (branch_id, year, month),
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_payroll_lines (
  id bigserial primary key,
  branch_id int not null references fin_branches(id), year int not null references fin_years(year),
  month int not null check (month between 1 and 12), sort_order int not null default 0,
  employee text not null, role text, base_hours numeric(10,2), actual_hours numeric(10,2), rate_per_26h numeric(14,2),
  deductions numeric(14,2), additions numeric(14,2), additions_details text, deductions_details text,
  lateness_days_recorded numeric(6,2), lateness_amount_recorded numeric(14,2),
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_payroll_owner_lines (
  id bigserial primary key,
  branch_id int not null references fin_branches(id), year int not null references fin_years(year),
  month int not null check (month between 1 and 12), name text not null, fixed_amount numeric(14,2) not null,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_commission_shares (
  id bigserial primary key,
  branch_id int not null references fin_branches(id), year int not null references fin_years(year),
  month int not null check (month between 1 and 12), sort_order int not null default 0,
  employee text not null, share_pct numeric(7,4) check (share_pct between 0 and 1),
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_history_monthly (
  id bigserial primary key,
  branch_id int not null references fin_branches(id), year int not null, month int not null check (month between 1 and 12),
  days int, gross_sales numeric(14,3), returns numeric(14,2), net_sales numeric(14,2), gross_profit numeric(14,2),
  invoices int, items_sold int, loyalty_points numeric(14,2), purchases_gross numeric(14,2), purchase_returns numeric(14,2),
  salaries numeric(14,2), opex numeric(14,2), maintenance numeric(14,2),
  unique (branch_id, year, month),
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists fin_shared_expenses (
  id bigserial primary key,
  fiscal_year int not null references fin_years(year),
  date date, description text not null, category_key text references fin_expense_categories(key) on update cascade,
  amount numeric(14,2) not null, period_override int check (period_override between 1 and 12), notes text,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);

-- a closed (branch, year, month) is read-only until an owner reopens it; branch_id NULL = shared ledger
create table if not exists fin_month_closings (
  id bigserial primary key,
  branch_id int references fin_branches(id), year int not null references fin_years(year),
  month int not null check (month between 1 and 12), closed_at timestamptz not null default now(), closed_by uuid, note text,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);
create unique index if not exists fin_month_closings_unique on fin_month_closings (coalesce(branch_id, 0), year, month);

create table if not exists fin_audit (
  id bigserial primary key,
  table_name text not null, row_id text, branch_id int,
  action text not null check (action in ('INSERT','UPDATE','DELETE')),
  old_data jsonb, new_data jsonb, changed_by uuid, changed_at timestamptz not null default now()
);
create index if not exists fin_audit_time on fin_audit (changed_at desc);

-- ---------------------------------------------------------------- row level security: OWNERS ONLY
do $$
declare t text;
begin
  foreach t in array array[
    'fin_settings','fin_years','fin_branches','fin_branch_settings','fin_expense_categories','fin_asset_categories',
    'fin_adjustment_reasons','fin_opening_balances','fin_monthly_inputs','fin_expenses','fin_stock_adjustments','fin_assets',
    'fin_staff','fin_staff_assignments','fin_lateness','fin_payroll_months','fin_payroll_lines','fin_payroll_owner_lines',
    'fin_commission_shares','fin_history_monthly','fin_shared_expenses','fin_month_closings','fin_audit'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists fin_owner on %I', t);
    if t = 'fin_audit' then
      execute format('create policy fin_owner on %I for select to authenticated using (public.fin_is_owner())', t);
      execute format('revoke all on %I from public, anon, authenticated', t);
      execute format('grant select on %I to authenticated', t);
    else
      execute format('create policy fin_owner on %I for all to authenticated using (public.fin_is_owner()) with check (public.fin_is_owner())', t);
      execute format('revoke all on %I from public, anon, authenticated', t);
      execute format('grant select, insert, update, delete on %I to authenticated', t);
    end if;
  end loop;
end $$;
do $$ declare s text; begin
  for s in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'S' and c.relname like 'fin\_%' loop
    execute format('revoke all on sequence %I from public, anon', s);
    execute format('grant usage, select on sequence %I to authenticated', s);
  end loop;
end $$;

-- ---------------------------------------------------------------- fiscal helpers (mirror the engine)
-- period(d) = (year(d) − Y) × 12 + month(d) + (day(d) ≥ start_day ? 1 : 0)
create or replace function public.fin_fiscal_period(d date, fiscal_year int, start_day int) returns int
language sql immutable as $$
  select case when d is null then null else
    (extract(year from d)::int - fiscal_year) * 12 + extract(month from d)::int
    + case when extract(day from d)::int >= start_day then 1 else 0 end end
$$;

create or replace function public.fin_start_day(fy int) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select start_day from fin_years where year = fy), 26) $$;

-- ---------------------------------------------------------------- who/when stamping + audit trail
create or replace function public.fin_stamp() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := coalesce(new.created_at, now()); new.created_by := coalesce(new.created_by, auth.uid());
  else
    new.created_at := old.created_at; new.created_by := old.created_by;
  end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;

create or replace function public.fin_audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  n jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  r jsonb := coalesce(n, o);
begin
  if coalesce(current_setting('fin.skip_audit', true), '') = 'on' then return coalesce(new, old); end if;
  if tg_op = 'UPDATE' and (o - 'updated_at' - 'updated_by') = (n - 'updated_at' - 'updated_by') then return new; end if;
  insert into fin_audit (table_name, row_id, branch_id, action, old_data, new_data, changed_by)
  values (tg_table_name, coalesce(r->>'id', r->>'key', r->>'year'), nullif(r->>'branch_id', '')::int, tg_op, o, n, auth.uid());
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------- month closing
create or replace function public.fin_is_month_closed(b int, y int, m int) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from fin_month_closings c where coalesce(c.branch_id, 0) = coalesce(b, 0) and c.year = y and c.month = m)
$$;

create or replace function public.fin_row_period(tbl text, r jsonb, out b int, out y int, out m int)
language plpgsql stable security definer set search_path = public as $$
declare d date; sd int;
begin
  b := nullif(r->>'branch_id', '')::int;
  if tbl in ('fin_monthly_inputs','fin_stock_adjustments','fin_payroll_months','fin_payroll_lines','fin_payroll_owner_lines','fin_commission_shares') then
    y := (r->>'year')::int; m := (r->>'month')::int;
  elsif tbl in ('fin_expenses','fin_shared_expenses') then
    y := (r->>'fiscal_year')::int;
    m := coalesce(nullif(r->>'period_override','')::int, fin_fiscal_period(nullif(r->>'date','')::date, y, fin_start_day(y)));
  elsif tbl = 'fin_opening_balances' then
    y := (r->>'year')::int; m := 1;
  elsif tbl in ('fin_lateness','fin_assets') then
    d := nullif(coalesce(r->>'date', r->>'date_added'), '')::date;
    if d is not null then
      y := extract(year from d)::int; sd := fin_start_day(y);
      if extract(month from d)::int = 12 and extract(day from d)::int >= sd then y := y + 1; end if;
      m := fin_fiscal_period(d, y, fin_start_day(y));
    end if;
  end if;
end $$;

create or replace function public.fin_enforce_open_month() returns trigger language plpgsql as $$
declare p record;
begin
  if coalesce(current_setting('fin.bypass_month_lock', true), '') = 'on' then return coalesce(new, old); end if;
  if tg_op in ('UPDATE','DELETE') then
    select * into p from fin_row_period(tg_table_name, to_jsonb(old));
    if p.y is not null and p.m between 1 and 12 and fin_is_month_closed(p.b, p.y, p.m) then
      raise exception 'MONTH_CLOSED' using errcode = 'P0001', hint = 'An owner must reopen the month first.';
    end if;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    select * into p from fin_row_period(tg_table_name, to_jsonb(new));
    if p.y is not null and p.m between 1 and 12 and fin_is_month_closed(p.b, p.y, p.m) then
      raise exception 'MONTH_CLOSED' using errcode = 'P0001', hint = 'An owner must reopen the month first.';
    end if;
  end if;
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'fin_settings','fin_years','fin_branches','fin_branch_settings','fin_expense_categories','fin_asset_categories',
    'fin_adjustment_reasons','fin_opening_balances','fin_monthly_inputs','fin_expenses','fin_stock_adjustments','fin_assets',
    'fin_staff','fin_staff_assignments','fin_lateness','fin_payroll_months','fin_payroll_lines','fin_payroll_owner_lines',
    'fin_commission_shares','fin_history_monthly','fin_shared_expenses','fin_month_closings'] loop
    execute format('drop trigger if exists fin_stamp on %I', t);
    execute format('create trigger fin_stamp before insert or update on %I for each row execute function public.fin_stamp()', t);
    execute format('drop trigger if exists fin_audit on %I', t);
    execute format('create trigger fin_audit after insert or update or delete on %I for each row execute function public.fin_audit_row()', t);
  end loop;
  foreach t in array array['fin_opening_balances','fin_monthly_inputs','fin_expenses','fin_stock_adjustments','fin_assets','fin_lateness',
    'fin_payroll_months','fin_payroll_lines','fin_payroll_owner_lines','fin_commission_shares','fin_shared_expenses'] loop
    execute format('drop trigger if exists fin_month_lock on %I', t);
    execute format('create trigger fin_month_lock before insert or update or delete on %I for each row execute function public.fin_enforce_open_month()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- one-shot data import (owners only)
-- Called by the site (المالية → الإعدادات → استيراد حزمة البيانات) to wipe the finance tables before a
-- fresh import. Refuses anyone who is not an owner. The audit trail is kept.
create or replace function public.fin_reset_data() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not fin_is_owner() then raise exception 'not_allowed'; end if;
  perform set_config('fin.bypass_month_lock', 'on', true);
  perform set_config('fin.skip_audit', 'on', true);
  delete from fin_month_closings; delete from fin_shared_expenses; delete from fin_history_monthly; delete from fin_commission_shares;
  delete from fin_payroll_owner_lines; delete from fin_payroll_lines; delete from fin_payroll_months; delete from fin_lateness;
  delete from fin_staff_assignments; delete from fin_staff; delete from fin_assets; delete from fin_stock_adjustments;
  delete from fin_expenses; delete from fin_monthly_inputs; delete from fin_opening_balances; delete from fin_branch_settings;
  delete from fin_branches; delete from fin_adjustment_reasons; delete from fin_asset_categories; delete from fin_expense_categories;
  delete from fin_years; delete from fin_settings;
  insert into fin_audit (table_name, action, new_data, changed_by) values ('fin_*', 'DELETE', '{"reset": true}'::jsonb, auth.uid());
end $$;

-- Functions: nobody but signed-in users may run them (the security-hardening script revokes them by default).
do $$ declare f text; begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'fin\_%' loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

select 'تم ✓ — قسم المالية جاهز (للمالك فقط)' as result;
