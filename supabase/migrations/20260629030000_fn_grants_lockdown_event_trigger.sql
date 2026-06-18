-- Durable guard against the "new public function is anon/authenticated-executable"
-- recurrence.
--
-- Background: PR1 revoked EXECUTE from anon/authenticated on existing public
-- functions and pinned the `postgres` role's default ACL. But two gaps remained:
--   1. The `supabase_admin` role's default ACL still grants anon/authenticated
--      EXECUTE on functions it creates, and the migration role (`postgres`) is
--      NOT a member of `supabase_admin`, so it cannot run
--      `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin ...`.
--   2. A migration that does an explicit `GRANT EXECUTE ... TO PUBLIC/anon/
--      authenticated` (what actually happened with rls_auto_enable /
--      try_reserve_sms_outbound_slot) bypasses default ACLs entirely.
--
-- This DDL event trigger closes BOTH gaps at the source: after any CREATE/ALTER
-- FUNCTION in the `public` schema it revokes EXECUTE from public/anon/
-- authenticated (skipping extension-owned functions). Policy: every public
-- function is service_role-only; callable surfaces go through service-role
-- clients, never anon/authenticated RPC. Mirrors the existing `rls_auto_enable`
-- event-trigger pattern already in this database.

create or replace function public.fn_grants_lockdown()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  obj record;
begin
  for obj in
    select * from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE FUNCTION', 'ALTER FUNCTION')
      and schema_name = 'public'
  loop
    -- Leave extension-owned functions (citext, pg_trgm, etc.) untouched.
    if exists (
      select 1 from pg_depend d where d.objid = obj.objid and d.deptype = 'e'
    ) then
      continue;
    end if;
    begin
      execute format('revoke execute on function %s from public, anon, authenticated', obj.object_identity);
    exception when others then
      -- Non-fatal: a function owned by a role we can't revoke on (e.g.
      -- supabase_admin) must not abort the DDL transaction.
      raise log 'fn_grants_lockdown: could not revoke on % (%).', obj.object_identity, sqlerrm;
    end;
  end loop;
end;
$$;

revoke execute on function public.fn_grants_lockdown() from public, anon, authenticated;

drop event trigger if exists trg_fn_grants_lockdown;
create event trigger trg_fn_grants_lockdown
  on ddl_command_end
  when tag in ('CREATE FUNCTION', 'ALTER FUNCTION')
  execute function public.fn_grants_lockdown();
