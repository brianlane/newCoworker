-- Raise the hardware-migration lease from 30 to 60 minutes.
--
-- The lease was sized in 20260731000100 as "double the route's 300s
-- maxDuration with slack". PR #1014 raised
-- /api/admin/vps/[businessId]/migrate-size to maxDuration = 1800 (30 min) and
-- left the lease at 30, so the lease now expires at exactly the moment the
-- route's own budget runs out, not after it. hasActiveVpsMigrationLock then
-- reads false while the migration is genuinely still running, and a second
-- migration (an admin click, or the daily term-renewal sweep) can claim the
-- same business and treat the in-flight cutover box as the "old" VM.
--
-- 60 minutes restores the original invariant: strictly greater than the
-- longest the migration can legitimately run. Leases still self-expire, so a
-- crashed job cannot wedge a business permanently; it just waits longer.
--
-- Only the default changes. Callers that pass p_lease_minutes explicitly are
-- unaffected.
--
-- grants: none (try_claim_vps_migration): replaces an existing function; the
-- revoke/grant pair below is carried over verbatim from 20260731000100.

create or replace function public.try_claim_vps_migration(
  p_business_id uuid,
  p_requested_by text,
  p_target_size text,
  p_lease_minutes integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count int;
begin
  insert into public.vps_migration_locks (business_id, locked_until, requested_by, target_size)
  values (p_business_id, now() + make_interval(mins => p_lease_minutes), p_requested_by, p_target_size)
  on conflict (business_id) do update
    set locked_until = excluded.locked_until,
        requested_by = excluded.requested_by,
        target_size = excluded.target_size,
        created_at = now()
    where vps_migration_locks.locked_until < now();
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke execute on function public.try_claim_vps_migration(uuid, text, text, integer) from public;
grant execute on function public.try_claim_vps_migration(uuid, text, text, integer) to service_role;
