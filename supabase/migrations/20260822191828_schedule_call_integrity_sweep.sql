-- Schedule the call-integrity-sweep Edge function via pg_cron + pg_net.
--
-- Runs daily at 13:40 UTC (06:40 Phoenix), off the top-of-hour cron bursts
-- and after the overnight calls have settled. The sweep reads the last 26
-- hours of voice transcripts and reports calls where the AI voiced BOTH
-- sides of the conversation, or held a conversation with a recording.
--
-- Why daily rather than per-call: both failures are the model disobeying its
-- prompt (the rules in PR #1377), which no code check can catch, and the
-- observed rate is roughly one event every seven weeks. A daily sweep turns
-- "someone eventually reads a transcript" into "it is named the next
-- morning": the 2026-06-27 instance went unnoticed for seven weeks.
--
-- The sweep is idempotent. It skips calls it has already reported (by
-- transcript id in system_logs), so a missed, delayed or overlapping tick
-- costs nothing and never double-alerts.
--
-- Call chain:
--   pg_cron -> net.http_post -> Edge `call-integrity-sweep`
--
-- Security model mirrors 20260630000100_schedule_aiflow_library_refresh.sql:
-- the Bearer secret and Edge base URL come from Supabase Vault
-- (`internal_cron_secret`, `edge_base_url`) read at execution time via
-- `public._cron_vault_read`. Missing secrets fail safe (empty URL/bearer ->
-- the Edge function returns 401; nothing runs until Vault setup is complete).
--
-- timeout_milliseconds is 120000, under the 150s Supabase Edge request
-- ceiling, so pg_net never hangs up before the function can answer
-- (tests/cron-timeout-parity.test.ts).
--
-- grants: none (schedule_call_integrity_sweep): creates no tables, views or
-- functions. It only schedules a pg_cron job, so there is no Data API object
-- to grant on.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $unschedule$
begin
  perform cron.unschedule('edge-call-integrity-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-call-integrity-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-call-integrity-sweep',
  '40 13 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/call-integrity-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
