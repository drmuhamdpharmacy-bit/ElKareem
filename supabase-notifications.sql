-- ════════════════════════════════════════════════════════════════════
--  صيدليات الكريم — requests: reason for a rejection (and, later, notifications)
--  Supabase → SQL Editor → paste all → Run. Safe to run more than once.
--  It only ADDS a column and a function; nothing existing is changed.
-- ════════════════════════════════════════════════════════════════════

-- 1. Leave / late-permission requests: the reason the supervisor or owner gives when rejecting
alter table public.leave_requests add column if not exists decision_note text;

create or replace function public.leave_decision_note(p_id bigint, p_note text)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare
  v_role   text;
  v_branch text;
  v_req    public.leave_requests;
begin
  select role, branch into v_role, v_branch from public.profiles where id = auth.uid();
  select * into v_req from public.leave_requests where id = p_id;
  if v_req.id is null then raise exception 'not_found'; end if;
  -- the owner, or a supervisor of the request's branch
  if not (v_role = 'owner' or (v_role = 'senior' and v_req.branch = v_branch)) then raise exception 'not_allowed'; end if;
  update public.leave_requests set decision_note = nullif(btrim(coalesce(p_note, '')), '') where id = p_id;
end $function$;

revoke all on function public.leave_decision_note(bigint, text) from public, anon;
grant execute on function public.leave_decision_note(bigint, text) to authenticated;
