-- Schedule the webhook-dispatcher Edge cron every minute.
--
-- REST-hook deliveries (Zapier triggers) are cursor-polled, so worst-case
-- latency is ~60s plus function runtime — the same cadence the
-- scheduled-SMS sweep uses. Each subscription advances its own cursor only
-- after a successful delivery, so overlapping/failed runs are safe.
--
-- Secrets required (already set in Supabase Vault by
-- 20260422000000_schedule_edge_crons.sql — single source of truth):
--   * internal_cron_secret — Bearer for the Edge function's cron auth
--   * edge_base_url        — https://<project-ref>.supabase.co

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent re-schedule.
do $unschedule$
begin
  perform cron.unschedule('edge-webhook-dispatcher')
  where exists (
    select 1 from cron.job where jobname = 'edge-webhook-dispatcher'
  );
end
$unschedule$;

select cron.schedule(
  'edge-webhook-dispatcher',
  '* * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/webhook-dispatcher',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 50000
  );
  $$
);
