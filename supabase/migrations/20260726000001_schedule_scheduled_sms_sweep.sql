-- Schedule the scheduled-SMS dispatch Edge cron every minute.
--
-- Owners pick a minute-granular send time in the dashboard, so the sweep runs
-- every minute (worst-case dispatch latency ~60s plus function runtime). Each
-- run claims due rows via claim_due_scheduled_sms (FOR UPDATE SKIP LOCKED), so
-- overlapping invocations are safe.
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
  perform cron.unschedule('edge-scheduled-sms-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-scheduled-sms-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-scheduled-sms-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/scheduled-sms-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 50000
  );
  $$
);
