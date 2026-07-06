-- In-flight guard for elective hardware migrations (admin migrate-size).
--
-- The migrate-size route answers 202 and runs a multi-minute background
-- migration (snapshot → backup → provision → restore → billing repoint →
-- old-box teardown). Without a guard, a second POST during that window
-- passes the route's point-in-time checks and launches an overlapping
-- migration that treats the first run's cutover box as the "old" VM —
-- duplicate hardware purchases, wrong backups/teardown, untracked billing.
--
-- Lease semantics (NOT a plain unique insert): the background job can die
-- without cleanup (deploy restart, function timeout), so a stuck row must
-- self-expire. `try_claim_vps_migration` atomically claims when no lease
-- exists or the existing lease has expired; the migration releases the
-- lease in its terminal path, and an expired lease is claimable again.
create table if not exists public.vps_migration_locks (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  locked_until timestamptz not null,
  requested_by text not null,
  target_size text not null,
  created_at timestamptz not null default now()
);

alter table public.vps_migration_locks enable row level security;

drop policy if exists "Service role manages vps_migration_locks" on public.vps_migration_locks;
create policy "Service role manages vps_migration_locks"
  on public.vps_migration_locks for all
  using (auth.role() = 'service_role');

-- Returns true exactly once per lease window: the caller that gets true owns
-- the migration; everyone else must refuse with 409. The upsert's WHERE
-- clause makes takeover of an expired lease atomic (no read-then-write race).
create or replace function public.try_claim_vps_migration(
  p_business_id uuid,
  p_requested_by text,
  p_target_size text,
  p_lease_minutes integer default 30
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

create or replace function public.release_vps_migration_lock(p_business_id uuid)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  delete from public.vps_migration_locks where business_id = p_business_id;
$$;

revoke execute on function public.release_vps_migration_lock(uuid) from public;
grant execute on function public.release_vps_migration_lock(uuid) to service_role;
