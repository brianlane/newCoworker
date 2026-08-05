-- Give the inbound SMS worker a way to hand back claims it never started, and
-- raise its pg_cron timeout to cover the batch budget that now bounds it.
--
-- The bug: every per-job timeout in sms-inbound-worker was sized against the
-- pg_cron cap as if ONE job ran per invocation. ROWBOAT_RETRY_BUDGET_MS is
-- documented as "the 90s cron cap minus a 10s reserve" and
-- OWNER_SMS_TURN_TIMEOUT_MS has "the same worst-case budget shape". But the
-- worker claims up to 8 jobs (claim_sms_inbound_jobs p_limit := 8) and works
-- them sequentially, so nothing bounded the batch: eight slow jobs could run
-- roughly 12 minutes.
--
-- Two things cut that short today, neither gracefully. Supabase 504s an Edge
-- function that has not responded within 150s, and pg_cron hangs up at 90s.
-- Either way the worker dies mid-batch and its remaining claims stay at
-- 'processing'. Those rows block their contact's queue, because
-- claim_sms_inbound_jobs will not claim a newer job for a contact that already
-- has one in flight, until the stale-claim recovery sweep resets them. Every
-- recovery also burns one of the job's MAX_ATTEMPTS = 8 retries. So a busy
-- minute silently spends a waiting customer's retry budget.
--
-- Two changes here, paired with the wall-clock budget added in
-- supabase/functions/_shared/sms_inbound_budget.ts:
--
--   1. release_sms_inbound_jobs(uuid[]) puts untouched claims straight back to
--      'pending' with attempt_count restored, so deferring a job to the next
--      tick (30s away) costs nothing.
--   2. edge-sms-inbound-worker's timeout goes from 90000 to 150000, covering
--      the new worst case of SMS_INBOUND_BATCH_BUDGET_MS (50s) plus one
--      worst-case job (90s) = 140s, which also keeps a 10s reserve under the
--      150s Supabase request ceiling.
--
-- See the README section "The cron chain has three timeouts, and a hard
-- ceiling under all of them".
--
-- grants: release_sms_inbound_jobs is service_role only (granted below); the
-- worker calls it with the service key. Creates no tables.

create or replace function public.release_sms_inbound_jobs(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_released integer;
begin
  -- Only rows still 'processing' are released. A job that reached a terminal
  -- state between the worker deciding to defer it and this call (it cannot
  -- today, but the guard keeps the RPC safe to call with a stale list) keeps
  -- its outcome.
  --
  -- attempt_count goes back down because the claim incremented it for an
  -- attempt that never happened. Without this, deferring a job would spend a
  -- retry and a busy queue would dead-letter healthy messages.
  update sms_inbound_jobs
  set
    status = 'pending',
    processing_started_at = null,
    attempt_count = greatest(0, attempt_count - 1),
    updated_at = now()
  where id = any(p_ids)
    and status = 'processing';

  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

revoke execute on function public.release_sms_inbound_jobs(uuid[]) from public;
grant execute on function public.release_sms_inbound_jobs(uuid[]) to service_role;

-- Schedule and body carried over verbatim from
-- 20260713220226_sms_inbound_worker_30s_cadence.sql; only
-- timeout_milliseconds changes. '30 seconds' is pg_cron interval syntax, not
-- a cron expression: this job runs twice a minute.
select cron.unschedule('edge-sms-inbound-worker')
where exists (
  select 1 from cron.job where jobname = 'edge-sms-inbound-worker'
);

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
    timeout_milliseconds := 150000
  );
  $$
);
