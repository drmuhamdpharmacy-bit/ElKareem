-- ════════════════════════════════════════════════════════════════════
--  صيدليات الكريم — security hardening (Supabase → SQL Editor → Run)
--  Safe to run more than once. Changes NO data and NO feature of the website:
--  it only removes permissions the website never uses.
-- ════════════════════════════════════════════════════════════════════

-- 1. Internal helper functions (names starting with "_") are used only INSIDE other
--    database functions, never by the website. Nobody may call them directly — otherwise
--    a logged-in user could, for example, call _create_user (it has no owner check of its own)
--    or _qr_sig (it produces valid attendance QR codes).
do $$ declare fn text; begin
  for fn in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like '\_%' loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
  end loop;
end $$;
-- …and the same for helper functions created in the future
alter default privileges in schema public revoke execute on functions from public;

-- 2. Table permissions the website never uses. TRUNCATE (empty a whole table) is not
--    limited by the row rules, so it should not be granted at all.
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;

-- 3. Visitors who are not logged in: no table access at all (the row rules already return
--    nothing; this removes the permission itself).
revoke all on all tables in schema public from anon;

-- 4. Old table ek_store (not used by the website; it has no row rules, so it is closed anyway).
do $$ begin if to_regclass('public.ek_store') is not null then execute 'revoke all on ek_store from authenticated'; end if; end $$;

-- Check (optional): run this to see that logged-in users can no longer call the helpers.
-- select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as can_call
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname like '\_%' order by 1;
