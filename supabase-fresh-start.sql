-- ════════════════════════════════════════════════════════════════════
--  صيدليات الكريم — FRESH START (Supabase → SQL Editor → paste all → Run)
--  Run ONCE, after closing the website on every device.
--
--  DELETES (for both branches):
--    • attendance check-ins, check-out fix requests, old leave requests (ended before today)
--    • sales, hours, badges, bonuses, penalties, withdrawals, missions, messages
--    • change log (audit)
--    • CRM history: calls, finished follow-ups, CRM change log
--  KEEPS:
--    • branches and all settings (shift hours, location, commission tiers + on/off, KPI weights, targets, shift schedule)
--    • employees, login accounts (owner, supervisors, employees, attendance screens)
--    • CRM customers with their medical info and care plans; upcoming follow-ups
--      (follow-ups that were already overdue are moved to today, so nobody starts the month late)
--    • leave requests that are still running or in the future
--
--  A full copy of everything deleted is saved first in the private schema «fresh_start_backup»
--  (not reachable from the website), so it can be restored if needed.
-- ════════════════════════════════════════════════════════════════════
begin;

-- 1. Backup (fails on purpose if a backup already exists, so a second run cannot overwrite it)
create schema fresh_start_backup;
create table fresh_start_backup.app_store      as select * from public.app_store;
create table fresh_start_backup.emp_view       as select * from public.emp_view;
create table fresh_start_backup.checkins       as select * from public.checkins;
create table fresh_start_backup.leave_requests as select * from public.leave_requests;
create table fresh_start_backup.fix_requests   as select * from public.fix_requests;
create table fresh_start_backup.audit_log      as select * from public.audit_log;
create table fresh_start_backup.crm_followups  as select * from public.crm_followups;
create table fresh_start_backup.crm_contacts   as select * from public.crm_contacts;
create table fresh_start_backup.crm_audit      as select * from public.crm_audit;
revoke all on schema fresh_start_backup from public, anon, authenticated;

-- 2. Work records stored per branch
update public.app_store set data = '{}'::jsonb, updated_at = now()
 where id ~ '/(monthly_data|attendance|missions|bonuses|penalties|withdrawals)$';
update public.app_store set data = '[]'::jsonb, updated_at = now()
 where id ~ '/messages$';

-- 3. Attendance and requests
delete from public.fix_requests;
delete from public.checkins;
delete from public.leave_requests where to_date < (now() at time zone 'Africa/Cairo')::date;

-- 4. Employees' personal pages: rebuilt automatically the next time the owner opens the website
delete from public.emp_view;

-- 5. CRM history (customers, medical info and care plans stay)
delete from public.crm_contacts;
delete from public.crm_followups where status not in ('open', 'postponed');
update public.crm_followups set due_date = (now() at time zone 'Africa/Cairo')::date, updated_at = now()
 where status in ('open', 'postponed') and due_date < (now() at time zone 'Africa/Cairo')::date;

-- 6. Change logs last (the steps above add their own entries to them)
delete from public.crm_audit;
delete from public.audit_log;

commit;

select 'تم ✓ — بداية جديدة. النسخة الاحتياطية محفوظة في fresh_start_backup' as result,
       (select count(*) from public.checkins) as checkins_left,
       (select count(*) from public.crm_customers) as crm_customers_kept,
       (select count(*) from public.crm_followups) as upcoming_followups_kept;
