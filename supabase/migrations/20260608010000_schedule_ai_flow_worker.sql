-- Schedule the ai-flow-worker Edge function via pg_cron + pg_net.
--
-- Mirrors 20260422000000_schedule_edge_crons.sql exactly (same Vault-backed
-- secret model: `internal_cron_secret` + `edge_base_url`, never embedded in
-- git). Runs every minute; the worker claims queued ai_flow_runs with
-- FOR UPDATE SKIP LOCKED, so overlapping minutes are safe.
--
-- A 60s timeout (vs the SMS worker's 30s) gives a run room for a browse+extract
-- step (page fetch + Gemini call) within a single invocation.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $unschedule$
begin
  perform cron.unschedule('edge-ai-flow-worker')
  where exists (select 1 from cron.job where jobname = 'edge-ai-flow-worker');
end
$unschedule$;

select cron.schedule(
  'edge-ai-flow-worker',
  '* * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/ai-flow-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
