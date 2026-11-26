-- ════════════════════════════════════════════════════════════════════
--  صيدليات الكريم — employees who work in more than one branch
--  (Supabase → SQL Editor → paste all → Run). Safe to run more than once.
--
--  An employee is "in" a branch when that branch's staff list (app_store '<branch>/employees')
--  contains their code. Their login account keeps its main branch; with this script they can also:
--   • check in / out with the QR code of any other branch they are listed in
--     (if they are still checked in at the other branch, that one is closed automatically first);
--   • see their own attendance in that branch;
--   • see their personal page for that branch (snapshot row '<code>@<branch>');
--   • complete missions and read messages from that branch
--     (a mission marked «صورة إثبات إلزامية» can only be completed after its photo is uploaded).
--  Nothing changes for employees who work in one branch only.
-- ════════════════════════════════════════════════════════════════════

-- 1. Helpers (internal; nobody may call them directly)
create or replace function public._emp_in_branch(p_branch text, p_emp text, p_active boolean default true)
 returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_emp is not null and p_branch is not null and exists (
    select 1 from public.app_store s, jsonb_array_elements(s.data) e
     where s.id = p_branch || '/employees' and jsonb_typeof(s.data) = 'array' and e ->> 'id' = p_emp
       and (not p_active or coalesce(e ->> 'leftMk', '') = ''))
$$;

-- every branch the employee belongs to: the account's main branch + branches whose staff list has them
create or replace function public._emp_branches(p_emp text, p_home text)
 returns text[] language sql stable security definer set search_path to 'public' as $$
  select array(select distinct x from (
    select p_home as x
    union all
    select b ->> 'id' from public.app_store s, jsonb_array_elements(s.data) b
     where s.id = 'branches' and jsonb_typeof(s.data) = 'array' and public._emp_in_branch(b ->> 'id', p_emp, false)
  ) t where x is not null)
$$;

revoke execute on function public._emp_in_branch(text, text, boolean) from public, anon, authenticated;
revoke execute on function public._emp_branches(text, text) from public, anon, authenticated;

-- 2. Check-in / check-out with the QR code of the branch where the employee is now
create or replace function public.emp_check(p_token text, p_lat double precision default null::double precision,
                                            p_lng double precision default null::double precision, p_kind text default null::text)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_emp  text := public.my_emp_id();
  v_b    text := public.my_branch();
  v_tb   text;                -- branch of the scanned QR code
  v_part text[];
  v_win  bigint;
  v_now  bigint := floor(extract(epoch from clock_timestamp()) / 30)::bigint;
  v_br   jsonb;
  v_dist double precision;
  v_last record;
  v_kind text;
  v_open boolean;
  v_el   interval;
  v_row  public.checkins;
  v_closed text;
begin
  if v_emp is null or v_b is null then raise exception 'not_employee'; end if;
  v_part := string_to_array(coalesce(p_token, ''), '.');
  if array_length(v_part, 1) <> 3 or v_part[2] !~ '^[0-9]+$' then raise exception 'invalid_code'; end if;
  v_tb := v_part[1];
  if v_tb <> v_b and not public._emp_in_branch(v_tb, v_emp) then raise exception 'wrong_branch'; end if;
  v_win := v_part[2]::bigint;
  if v_part[3] <> public._qr_sig(v_tb, v_win) then raise exception 'invalid_code'; end if;
  if v_win < v_now - 4 or v_win > v_now + 1 then raise exception 'expired_code'; end if;

  v_br := public._branch(v_tb);
  if coalesce(v_br ->> 'lat', '') <> '' and coalesce(v_br ->> 'lng', '') <> '' then
    if p_lat is null or p_lng is null then raise exception 'location_required'; end if;
    v_dist := 2 * 6371000 * asin(sqrt(
        power(sin(radians(p_lat - (v_br ->> 'lat')::float8) / 2), 2)
      + cos(radians((v_br ->> 'lat')::float8)) * cos(radians(p_lat)) * power(sin(radians(p_lng - (v_br ->> 'lng')::float8) / 2), 2)));
    if v_dist > coalesce(nullif(v_br ->> 'radius', '')::float8, 150) then
      raise exception 'too_far:%', round(v_dist);
    end if;
  end if;

  select id, kind, at, branch into v_last from public.checkins where emp_id = v_emp order by at desc, id desc limit 1;
  if found and v_last.at > now() - interval '60 seconds' then raise exception 'too_soon'; end if;
  v_open := found and v_last.kind = 'in' and v_last.at > now() - interval '16 hours';

  -- still checked in at ANOTHER branch: close that one now, then check in here
  if v_open and v_last.branch is distinct from v_tb then
    insert into public.checkins (emp_id, emp_name, branch, kind, at, user_id, source, note)
    values (v_emp, public._emp_name(v_last.branch, v_emp), v_last.branch, 'out', now() - interval '1 second',
            auth.uid(), 'auto', 'انصراف تلقائي — سجّل حضوراً في فرع آخر');
    v_closed := coalesce(public._branch(v_last.branch) ->> 'name', v_last.branch);
    v_open := false;
  end if;

  if v_open then
    v_el := now() - v_last.at;
    if v_el < make_interval(hours => (public._shift_hours(v_tb) + 1)::int) then
      v_kind := 'out';
    elsif p_kind in ('in', 'out') then
      v_kind := p_kind;
    else
      raise exception 'choose_kind:%', to_char(v_last.at at time zone 'Africa/Cairo', 'HH24:MI');
    end if;
  else
    v_kind := 'in';
  end if;

  insert into public.checkins (emp_id, emp_name, branch, kind, lat, lng, dist_m, user_id, source)
  values (v_emp, public._emp_name(v_tb, v_emp), v_tb, v_kind, p_lat, p_lng, round(v_dist), auth.uid(), 'qr')
  returning * into v_row;
  return jsonb_build_object('kind', v_row.kind, 'at', v_row.at, 'name', v_row.emp_name,
                            'since', case when v_kind = 'out' then v_last.at end,
                            'branch_name', coalesce(v_br ->> 'name', v_tb), 'closed_branch', v_closed);
end $function$;

-- 3. Attendance: an employee may read their own days in every branch they are listed in
create or replace function public.attendance_days(p_branch text, p_from timestamp with time zone, p_to timestamp with time zone, p_emp text default null::text)
 returns table(emp_id text, day date, first_in timestamp with time zone, last_out timestamp with time zone, minutes integer, forgot integer, fixed integer, open integer, forgot_in bigint)
 language plpgsql stable security definer set search_path to 'public' as $function$
declare v_shift numeric := public._shift_hours(p_branch);
begin
  if not (public.is_owner()
          or (public.my_role() = 'senior' and p_branch = public.my_branch())
          or (p_emp is not null and p_emp = public.my_emp_id()
              and (p_branch = public.my_branch() or public._emp_in_branch(p_branch, p_emp, false)))) then
    raise exception 'not_allowed';
  end if;
  return query
  with ev as (
    select c.id, c.emp_id, c.kind, c.at,
           lead(c.kind)   over w as nk, lead(c.at) over w as nat, lead(c.source) over w as nsrc
      from public.checkins c
     where c.branch = p_branch and c.at >= p_from - interval '1 day' and c.at < p_to + interval '1 day'
       and (p_emp is null or c.emp_id = p_emp)
    window w as (partition by c.emp_id order by c.at)
  ), pairs as (
    select e.id as in_id, e.emp_id, e.at as in_at,
           case when e.nk = 'out' and e.nat - e.at <= interval '16 hours' then e.nat end as out_at,
           case when e.nk = 'out' and e.nat - e.at <= interval '16 hours' then e.nsrc end as out_src
      from ev e
     where e.kind = 'in' and e.at >= p_from and e.at < p_to
  )
  select p.emp_id, (p.in_at at time zone 'Africa/Cairo')::date,
         min(p.in_at), max(p.out_at),
         sum(case when p.out_at is not null then extract(epoch from p.out_at - p.in_at) / 60
                  when now() - p.in_at > interval '16 hours' then v_shift * 60
                  else 0 end)::int,
         (count(*) filter (where p.out_at is null and now() - p.in_at > interval '16 hours'))::int,
         (count(*) filter (where p.out_src = 'request'))::int,
         (count(*) filter (where p.out_at is null and now() - p.in_at <= interval '16 hours'))::int,
         (array_agg(p.in_id) filter (where p.out_at is null and now() - p.in_at > interval '16 hours'))[1]
    from pairs p
   group by p.emp_id, (p.in_at at time zone 'Africa/Cairo')::date;
end $function$;

-- 4. Missions and messages from every branch the employee belongs to
create or replace function public.emp_mission_action(p_mk text, p_id text, p_action text, p_img text default null::text)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare
  v_emp   text := public.my_emp_id();
  v_b     text := public.my_branch();
  v_bs    text[];
  v_patch jsonb;
  v_can   boolean;
  v_req   boolean;   -- this mission needs a proof photo (set by the owner / supervisor)
  v_has   boolean;   -- the employee already uploaded it
begin
  if v_emp is null or v_b is null then raise exception 'not_employee'; end if;
  v_bs := public._emp_branches(v_emp, v_b);
  if p_id is not null then
    select bool_or(coalesce((m ->> 'photoRequired')::boolean, false)),
           bool_or(coalesce(m ->> 'employeeImageData', '') <> '')
      into v_req, v_has
      from public.app_store s, jsonb_array_elements(case when jsonb_typeof(s.data -> p_mk) = 'array' then s.data -> p_mk else '[]'::jsonb end) m
     where s.id = any(array(select x || '/missions' from unnest(v_bs) x))
       and m ->> 'id' = p_id and m ->> 'empId' = v_emp;
  end if;
  if p_action = 'complete' then
    if coalesce(v_req, false) and not coalesce(v_has, false) then raise exception 'photo_required'; end if;
    v_patch := '{"completed":true}'::jsonb;
  elsif p_action = 'seen' then
    v_patch := '{"seenByEmployee":true}'::jsonb; p_id := null;
  elsif p_action = 'photo' then
    if p_img is null or length(p_img) > 6000000
       or p_img !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' then raise exception 'bad_image'; end if;
    select bool_or(coalesce((e ->> 'canUploadPhoto')::boolean, false)) into v_can
      from public.app_store s, jsonb_array_elements(s.data) e
     where s.id = any(array(select x || '/employees' from unnest(v_bs) x))
       and jsonb_typeof(s.data) = 'array' and e ->> 'id' = v_emp;
    -- allowed for employees with photo permission, and always for a mission that requires a proof photo
    if not (coalesce(v_can, false) or coalesce(v_req, false)) then raise exception 'not_allowed'; end if;
    v_patch := jsonb_build_object('employeeImageData', p_img);
  else
    raise exception 'bad_action';
  end if;
  update public.app_store
     set data = public._patch_missions(data, p_mk, v_emp, p_id, v_patch, p_action), updated_at = now()
   where id = any(array(select x || '/missions' from unnest(v_bs) x));
  update public.emp_view
     set data = jsonb_set(data, '{missions}',
                 public._patch_missions(coalesce(data -> 'missions', '{}'::jsonb), p_mk, v_emp, p_id, v_patch, p_action)),
         updated_at = now()
   where (emp_id = v_emp or left(emp_id, length(v_emp) + 1) = v_emp || '@') and data is not null;
end $function$;

create or replace function public.emp_mark_messages_read()
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_emp text := public.my_emp_id(); v_b text := public.my_branch(); v_bs text[];
begin
  if v_emp is null or v_b is null then raise exception 'not_employee'; end if;
  v_bs := public._emp_branches(v_emp, v_b);
  update public.app_store
     set data = (select coalesce(jsonb_agg(case when m ->> 'to' = v_emp then m || '{"read":true}'::jsonb else m end order by ord), '[]'::jsonb)
                   from jsonb_array_elements(data) with ordinality as t(m, ord)),
         updated_at = now()
   where id = any(array(select x || '/messages' from unnest(v_bs) x)) and jsonb_typeof(data) = 'array'
     and exists (select 1 from jsonb_array_elements(data) m where m ->> 'to' = v_emp and coalesce(m ->> 'read', 'false') <> 'true');
  update public.emp_view
     set data = jsonb_set(data, '{messages}',
                 (select coalesce(jsonb_agg(m || '{"read":true}'::jsonb order by ord), '[]'::jsonb)
                    from jsonb_array_elements(data -> 'messages') with ordinality as t(m, ord))),
         updated_at = now()
   where (emp_id = v_emp or left(emp_id, length(v_emp) + 1) = v_emp || '@') and jsonb_typeof(data -> 'messages') = 'array';
end $function$;

-- 5. Personal page: an employee may also read their snapshot rows of other branches ('<code>@<branch>')
drop policy if exists view_read on public.emp_view;
create policy view_read on public.emp_view for select using (
  is_owner()
  or (my_role() = 'senior' and branch = my_branch())
  or emp_id = my_emp_id()
  or left(emp_id, length(my_emp_id()) + 1) = my_emp_id() || '@'
  or emp_id = ('_lb/' || my_branch()));

select 'تم ✓ — الموظف في أكثر من فرع جاهز' as result;
