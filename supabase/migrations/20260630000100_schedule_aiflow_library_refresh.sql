-- Schedule the aiflow-library-refresh Edge function via pg_cron + pg_net.
--
-- Runs hourly at :07 (offset off the top-of-hour cron bursts). The refresh is
-- idempotent (upsert by template_key), so a missed or overlapping tick is
-- harmless — the next hour reconciles the catalog.
--
-- Call chain:
--   pg_cron → net.http_post → Edge `aiflow-library-refresh`
--                            → Next.js POST /api/internal/aiflow-library-refresh
--
-- Security model mirrors 20260502000000_schedule_subscription_grace_sweep.sql:
-- the Bearer secret + Edge base URL come from Supabase Vault
-- (`internal_cron_secret`, `edge_base_url`) read at execution time via
-- `public._cron_vault_read`. Missing secrets fail safe (empty URL/bearer → the
-- Edge function returns 401; nothing runs until Vault setup is complete).

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $unschedule$
begin
  perform cron.unschedule('edge-aiflow-library-refresh')
  where exists (
    select 1 from cron.job where jobname = 'edge-aiflow-library-refresh'
  );
end
$unschedule$;

select cron.schedule(
  'edge-aiflow-library-refresh',
  '7 * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/aiflow-library-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
