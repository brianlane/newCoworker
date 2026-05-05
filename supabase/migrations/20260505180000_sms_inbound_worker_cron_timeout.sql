-- Bump the sms-inbound-worker cron HTTP timeout from 30s → 90s.
--
-- Why: the worker calls Rowboat /chat on the customer VPS, where local
-- Ollama (kvm2-llama32 starter, kvm8-qwen standard) routinely takes
-- 12–25s for a typical SMS reply, plus ~2–4s of Edge cold-start. With a
-- 30s pg_cron HTTP timeout, in-flight Rowboat fetches got truncated
-- mid-call: pg_cron disconnected at 30s, the function then logged
-- `rowboat_timeout` when its own 60s timer fired against an already-
-- closed socket, and the row stayed dangling at status='processing'
-- until claim_sms_inbound_jobs' stale-claim recovery requeued it. Net
-- effect: every SMS reply needed multiple cron ticks to actually go out,
-- and longer Rowboat replies (>30s) never went out at all.
--
-- 90s gives the worker headroom for: Edge cold-start (~2s) + chat fetch
-- (up to 60s — the worker's own ROWBOAT_CHAT_TIMEOUT_MS guard) + Telnyx
-- send + DB writes + telemetry. Still well under the Edge function's
-- ~150s ceiling, and well under the 1-minute cron interval so we never
-- queue up two runs of the same tick.
--
-- This migration is idempotent (cron.unschedule + cron.schedule with the
-- same job name re-creates the schedule) and safe to apply in production
-- — we only touch the `edge-sms-inbound-worker` job, the others are
-- left as-is.

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
  '* * * * *',
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
