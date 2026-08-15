-- Schedule the daily fleet VPS contract-upgrade sweep via pg_cron + pg_net.
--
-- Runs at 10:30 UTC, half an hour BEFORE the term-renewal sweep at 11:00.
-- The two are deliberately separate jobs rather than two candidate classes
-- in one run: each migrates at most one tenant per run, so sharing a run
-- would let whichever class sorted first starve the other indefinitely.
--
-- Contract upgrades go first because they are the cheaper correction. A
-- contract tenant sitting on a monthly box is paying the platform's most
-- expensive per-month rate ($24.49/mo for a kvm2 vs $8.99/mo on a 2-year
-- term), so moving them saves more than replacing an already-term-priced
-- box that is merely about to renew. The half-hour gap keeps them from
-- competing for the same per-business migration lease.
--
-- Call chain:
--   pg_cron → net.http_post → Edge `vps-contract-upgrade-sweep`
--                            → Next.js POST /api/internal/vps-contract-upgrade-sweep
--                            → runContractUpgradeSweep(...) (at most one
--                              migration per run, ops email per migration).
--
-- Security model mirrors the other edge crons: the bearer secret is read
-- from Supabase Vault at schedule-execution time via
-- `public._cron_vault_read`, so rotating it does not require a migration.
--
-- grants: none (no objects created): this migration only schedules a cron
-- job; it creates no table, view, or function that the Data API could
-- expose.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $unschedule$
begin
  perform cron.unschedule('edge-vps-contract-upgrade-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-vps-contract-upgrade-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-vps-contract-upgrade-sweep',
  '30 10 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/vps-contract-upgrade-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    -- 1800s, matching the route's maxDuration and the Edge bridge's
    -- REQUEST_TIMEOUT_MS. All three layers have to agree: pg_net hanging up
    -- first does not stop the Next function, so every healthy run would be
    -- recorded as a timeout in cron.job_run_details and a genuine timeout
    -- would be impossible to spot.
    --
    -- The sibling sweep shipped at 800000 and needed
    -- 20260822013908_raise_term_renewal_sweep_cron_timeout.sql to correct
    -- exactly this, so this one starts at the right value. Note the
    -- cron-timeout parity test only guards the route and the Edge bridge;
    -- this third layer is not covered, which is why it drifts unnoticed.
    timeout_milliseconds := 1800000
  );
  $$
);
