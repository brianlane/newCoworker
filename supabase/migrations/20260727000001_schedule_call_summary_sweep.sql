-- Schedule the call-summary Edge cron every 5 minutes.
--
-- Call summaries are not latency-sensitive (the owner reads them minutes to
-- hours after the call), so a 5-minute cadence keeps invocation volume low.
-- Each run scans a small window of recently completed, unsummarized calls for
-- Standard/Enterprise tenants and dispatches them to the Next.js summarizer
-- endpoint one at a time.
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
  perform cron.unschedule('edge-call-summary-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-call-summary-sweep'
  );
end
$unschedule$;

-- 120s timeout: the sweep dispatches sequentially under an 85s wall-clock
-- budget, and one in-flight dispatch can hold up to the summarize endpoint's
-- 30s maxDuration past that budget (~115s worst case). Leftover rows are
-- deferred to the next 5-minute pass, so the run always fits.
select cron.schedule(
  'edge-call-summary-sweep',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/call-summary-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
