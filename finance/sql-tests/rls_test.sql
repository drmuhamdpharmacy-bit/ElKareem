-- Run: psql -v ON_ERROR_STOP=1 -f rls_test.sql   (after app_stub.sql + supabase-finance.sql, twice)
\set QUIET on
create or replace function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false);
  execute 'set role authenticated';
end $$;

-- 1. an owner can write and read
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into fin_settings (id, current_year) values (1, 2026) on conflict (id) do nothing;
insert into fin_years (year, report_month, app_payroll_from_month) values (2026, 10, 11) on conflict do nothing;
insert into fin_branches (id, name_ar, name_en, app_branch) values (1, 'الفرع 1', 'Branch 1', 'b1') on conflict do nothing;
insert into fin_expense_categories (key, name_ar, name_en, pl_class) values ('UTIL','مرافق','Utilities','OPEX') on conflict do nothing;
insert into fin_monthly_inputs (branch_id, year, month, gross_sales, returns, gross_profit) values (1, 2026, 1, 100000.00, 2000.00, 30000.00) on conflict do nothing;
insert into fin_expenses (branch_id, fiscal_year, date, description, category_key, amount) values (1, 2026, '2026-03-05', 'كهرباء', 'UTIL', 190);
do $$ begin
  if (select count(*) from fin_monthly_inputs) <> 1 then raise exception 'FAIL owner cannot read'; end if;
  if (select count(*) from fin_audit) < 3 then raise exception 'FAIL audit not written'; end if;
  if (select created_by from fin_expenses limit 1) <> '00000000-0000-0000-0000-00000000000a' then raise exception 'FAIL stamping'; end if;
end $$;
reset role;

-- 2. a second owner sees the same data
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin if (select count(*) from fin_expenses) <> 1 then raise exception 'FAIL second owner'; end if; end $$;
reset role;

-- 3. supervisor (even with every page ticked), employee, kiosk: nothing at all, no writes
do $$
declare u text; t text; n int;
begin
  foreach u in array array['00000000-0000-0000-0000-00000000000c','00000000-0000-0000-0000-00000000000d','00000000-0000-0000-0000-00000000000e'] loop
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    set local role authenticated;
    foreach t in array array['fin_settings','fin_years','fin_branches','fin_expense_categories','fin_monthly_inputs','fin_expenses',
                             'fin_payroll_lines','fin_payroll_owner_lines','fin_shared_expenses','fin_audit','fin_assets','fin_staff'] loop
      execute format('select count(*) from %I', t) into n;
      if n <> 0 then raise exception 'FAIL % can read % (% rows)', u, t, n; end if;
    end loop;
    begin
      insert into fin_expenses (branch_id, fiscal_year, date, description, category_key, amount) values (1, 2026, '2026-10-01', 'x', 'UTIL', 1);
      raise exception 'FAIL % could insert', u;
    exception when insufficient_privilege then null;  -- row-level security
    end;
    update fin_monthly_inputs set gross_sales = 0;
    delete from fin_expenses;
    begin
      perform fin_reset_data();
      raise exception 'FAIL % could reset', u;
    exception when raise_exception then
      if sqlerrm like 'FAIL%' then raise; end if;
    end;
    reset role;
  end loop;
end $$;

-- 4. anonymous visitors: no access at all
set role anon;
do $$ begin
  begin perform count(*) from fin_expenses; raise exception 'FAIL anon can select';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- 5. nothing was changed by the non-owners
do $$ begin
  if (select gross_sales from fin_monthly_inputs where month = 1) <> 100000.00 then raise exception 'FAIL value changed'; end if;
  if (select count(*) from fin_expenses) <> 1 then raise exception 'FAIL expense deleted'; end if;
end $$;

-- 6. month closing: owner closes March, edits fail, owner reopens (audited)
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into fin_month_closings (branch_id, year, month) values (1, 2026, 3);
do $$ begin
  begin update fin_expenses set amount = 1; raise exception 'FAIL edit in closed month';
  exception when raise_exception then if sqlerrm <> 'MONTH_CLOSED' then raise; end if; end;
end $$;
delete from fin_month_closings where month = 3;
update fin_expenses set amount = 191;
do $$ begin
  if (select count(*) from fin_audit where table_name = 'fin_month_closings') <> 2 then raise exception 'FAIL closing not audited'; end if;
  if (select (old_data->>'amount')::numeric from fin_audit where table_name='fin_expenses' and action='UPDATE' order by id desc limit 1) <> 190 then raise exception 'FAIL audit old value'; end if;
end $$;
-- 7. owner reset works
select fin_reset_data();
do $$ begin if (select count(*) from fin_expenses) + (select count(*) from fin_branches) <> 0 then raise exception 'FAIL reset'; end if; end $$;
reset role;
select '✔ supabase-finance.sql: owners only — all RLS tests passed' as result;
