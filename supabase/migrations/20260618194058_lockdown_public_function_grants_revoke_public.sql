-- Corrective follow-up to 20260618182009_lockdown_public_function_grants.sql.
--
-- That migration revoked EXECUTE from the `anon` and `authenticated` roles,
-- but a couple of SECURITY DEFINER functions (rls_auto_enable(),
-- try_reserve_sms_outbound_slot(uuid)) had EXECUTE granted to PUBLIC, not to
-- anon/authenticated directly. PUBLIC includes anon and authenticated, so the
-- Supabase advisor still flagged them as unauthenticated-callable and the
-- functions remained reachable via PostgREST RPC.
--
-- Revoke EXECUTE from PUBLIC (and re-affirm anon/authenticated) on every
-- non-extension public function. service_role keeps its own explicit grant and
-- the owner (postgres) keeps implicit EXECUTE, so legitimate callers and the
-- event trigger / pg_cron paths are unaffected. citext (extension) is excluded.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and not exists (
        select 1 from pg_depend d
        where d.objid = p.oid and d.deptype = 'e'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
  end loop;
end$$;
