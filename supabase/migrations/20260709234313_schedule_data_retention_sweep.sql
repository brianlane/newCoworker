-- Schedule the data-retention-sweep Edge function via pg_cron + pg_net.
--
-- Daily at 01:35 UTC — offset from the 00:15 grace sweep and the top-of-hour
-- bursts. Retention is a compliance janitor, not a hot path; once a day is
-- the disclosed cadence (a row can outlive its window by at most ~24h).
--
-- Call chain:
--   pg_cron → net.http_post → Edge `data-retention-sweep`
--                            → Next.js POST /api/internal/data-retention-sweep
--
-- Security model mirrors 20260422000000_schedule_edge_crons.sql: Bearer from
-- Vault (`internal_cron_secret`) via public._cron_vault_read, Edge base URL
-- from Vault (`edge_base_url`). Missing secrets fail safe (Edge returns 401).
-- Prereqs (pg_cron, pg_net, _cron_vault_read) exist from earlier migrations.

do $unschedule$
begin
  perform cron.unschedule('edge-data-retention-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-data-retention-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-data-retention-sweep',
  '35 1 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/data-retention-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);
