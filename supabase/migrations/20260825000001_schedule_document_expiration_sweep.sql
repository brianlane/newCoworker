-- Schedule the document-expiration-sweep Edge function via pg_cron + pg_net.
--
-- Daily at 02:05 UTC — offset from the 01:35 retention sweep and the
-- top-of-hour bursts. The sweep notifies owners about documents expiring
-- within the reminder window (and just-expired ones); expired docs are
-- already inert to the agent (excluded at read time), so a day of drift is
-- harmless.
--
-- Call chain:
--   pg_cron → net.http_post → Edge `document-expiration-sweep`
--                            → Next.js POST /api/internal/document-expiration-sweep
--
-- Security model mirrors 20260815000001_schedule_data_retention_sweep.sql:
-- Bearer from Vault (`internal_cron_secret`) via public._cron_vault_read,
-- Edge base URL from Vault (`edge_base_url`).

do $unschedule$
begin
  perform cron.unschedule('edge-document-expiration-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-document-expiration-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-document-expiration-sweep',
  '5 2 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/document-expiration-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);
