-- Schedule the daily fleet VPS orphan sweep via pg_cron + pg_net.
--
-- Runs at 14:00 UTC, after the term-renewal sweep (11:00) and the
-- billing-posture check (13:00), so it reads the fleet those two leave
-- behind rather than racing their inventory writes. The sweep's own 6-hour
-- age floor already makes that ordering non-load-bearing; this is just tidy.
--
-- Call chain:
--   pg_cron → net.http_post → Edge `vps-orphan-sweep`
--                            → Next.js POST /api/internal/vps-orphan-sweep
--                            → runOrphanSweep(...)
--
-- Finds Hostinger VMs with no vps_inventory row: pools the ones that were
-- never set up and belong to nobody (auto-renew off, so an unadopted box
-- lapses at period end), reports the rest for a human. VM 1806114 sat
-- untracked from 2026-07-05 because nothing ever looked.
--
-- Security model mirrors the other edge crons: bearer secret is read from
-- Supabase Vault at schedule-execution time via `public._cron_vault_read`,
-- so rotating the secret doesn't require a migration.
--
-- grants: none (cron schedule only; creates no objects).

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $unschedule$
begin
  perform cron.unschedule('edge-vps-orphan-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-vps-orphan-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-vps-orphan-sweep',
  '0 14 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/vps-orphan-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    -- Must not hang up before the route's maxDuration (300s) elapses, or a
    -- clean run is recorded as a cron timeout and a real one becomes
    -- invisible. Guarded by tests/cron-timeout-parity.test.ts.
    timeout_milliseconds := 360000
  );
  $$
);
