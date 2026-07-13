-- Run the SMS inbound worker every 30 seconds instead of every minute.
--
-- Truly feedback (Issue 5, 2026-07-13): replies felt slow. Outside outage
-- conditions the dominant latency is queue cadence — a text landing right
-- after a tick waited up to a full minute before the worker even claimed it.
-- pg_cron's seconds syntax halves that: median claim wait drops from ~30s
-- to ~15s, worst case from ~60s to ~30s.
--
-- Overlap safety (the 90s HTTP timeout now exceeds the interval, so up to
-- three invocations can be in flight):
--   * claim_sms_inbound_jobs is FOR UPDATE SKIP LOCKED — two ticks never
--     claim the same job;
--   * the claim is serialized per contact (idx/claim change of PR #566), so
--     concurrent ticks can't interleave one texter's replies;
--   * Telnyx sends are idempotency-keyed per job.
--
-- Idempotent: cron.unschedule + cron.schedule under the same job name, the
-- exact pattern of 20260505180000_sms_inbound_worker_cron_timeout.sql
-- (which this supersedes for scheduling; the 90s timeout is kept).

do
$body$
begin
  if exists (
    select 1 from cron.job where jobname = 'edge-sms-inbound-worker'
  ) then
    perform cron.unschedule('edge-sms-inbound-worker');
  end if;
end
$body$;

select cron.schedule(
  'edge-sms-inbound-worker',
  '30 seconds',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/sms-inbound-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 90000
  );
  $$
);
