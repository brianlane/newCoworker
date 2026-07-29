-- Schedule the daily fleet VPS term-renewal sweep via pg_cron + pg_net.
--
-- Runs at 11:00 UTC (a few hours before the billing-posture cron at 13:00
-- UTC) so eligible tenants migrate onto fresh first-period-priced boxes
-- before the posture check nags about renewal state.
--
-- Call chain:
--   pg_cron → net.http_post → Edge `vps-term-renewal-sweep`
--                            → Next.js POST /api/internal/vps-term-renewal-sweep
--                            → runTermRenewalSweep(...) (at most one migration
--                              per run, ops email per migration).
--
-- Security model mirrors the other edge crons: bearer secret is read from
-- Supabase Vault at schedule-execution time via `public._cron_vault_read`,
-- so rotating the secret doesn't require a migration.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $unschedule$
begin
  perform cron.unschedule('edge-vps-term-renewal-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-vps-term-renewal-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-vps-term-renewal-sweep',
  '0 11 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/vps-term-renewal-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 800000
  );
  $$
);
