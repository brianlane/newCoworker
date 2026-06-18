-- Security lockdown: remove EXECUTE on application-defined public functions
-- from the `anon` and `authenticated` roles.
--
-- Background
-- ----------
-- Supabase's default privileges grant EXECUTE on every new function in
-- `public` to `anon` and `authenticated`. Many of our functions are
-- `SECURITY DEFINER` and are meant to be called ONLY by `service_role`
-- (the app via the service client, and the Edge functions via the
-- service-role key) or by their owner (`postgres`, e.g. pg_cron jobs).
-- Earlier migrations attempted `revoke ... from public`, which does NOT
-- remove the direct `anon`/`authenticated` grants the default-privilege
-- policy plants, so the live database left 57 SECURITY DEFINER functions
-- (and several helpers) callable unauthenticated via PostgREST RPC
-- (`POST /rest/v1/rpc/<fn>`). Most dangerously, `public._cron_vault_read`
-- returned decrypted Supabase Vault secrets to any caller holding the
-- public anon key.
--
-- This migration revokes EXECUTE from `anon` and `authenticated` on every
-- function in `public` that is NOT owned by an extension (so the `citext`
-- operator/support functions keep working for normal queries on citext
-- columns, and pg_net stays intact). Legitimate callers are unaffected:
--   * service_role keeps its own EXECUTE grant (app + Edge functions),
--   * the owner (postgres) keeps implicit EXECUTE (pg_cron jobs, triggers,
--     event triggers fire as owner regardless of role grants).
--
-- Reversible: re-granting is a single statement per function. Verified
-- against every `.rpc()` call site in the repo — all run as service_role;
-- no browser/`authenticated`-session code calls any of these.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and not exists (
        select 1
        from pg_depend d
        where d.objid = p.oid
          and d.deptype = 'e'   -- skip functions owned by an extension (citext, etc.)
      )
  loop
    execute format('revoke execute on function %s from anon, authenticated', r.sig);
  end loop;
end$$;

-- Belt-and-suspenders: stop the default-privilege policy from re-exposing
-- functions created by the migration role in the future. New app functions
-- must opt in explicitly with `grant execute ... to service_role`.
alter default privileges in schema public revoke execute on functions from anon, authenticated;
