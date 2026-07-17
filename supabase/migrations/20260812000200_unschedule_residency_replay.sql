-- Unschedule the per-minute `edge-residency-replay` cron while ZERO tenants
-- use data residency.
--
-- The replay cron (scheduled by 20260804000000_residency_write_journal.sql)
-- drains `residency_write_journal` to each dual/vps-mode tenant's box every
-- minute. Today no business has `data_residency_mode` past the default
-- ('supabase') and the journal is empty, so the job burns ~1,440 Edge
-- invocations + `net.http_post` calls per day doing nothing. pg_stat
-- inspection (2026-07-17) showed the residency cron among the top total-time
-- SQL consumers purely from this idle churn.
--
-- Scope — deliberately surgical:
--   * ONLY `edge-residency-replay` is unscheduled. Every other cron
--     (ai-flow-worker, scheduled-sms-sweep, webhook-dispatcher,
--     messenger-jobs-sweep, email-campaign-sweep, the 30s
--     sms-inbound-worker, and all daily jobs) is latency-sensitive by
--     design and stays at its current cadence.
--   * The residency-replay Edge function, /api/internal/residency-replay,
--     the journal table, and its triggers all stay deployed — flipping a
--     tenant to `dual` requires only re-adding the schedule.
--   * Re-enabling is STEP 1 of the per-tenant residency enablement runbook
--     (README, "Data residency" section): run the cron.schedule() block
--     from 20260804000000_residency_write_journal.sql BEFORE the backfill/
--     drain step, since dual mode depends on the journal being drained.
--
-- Guarded the same way the original migration guarded its own reschedule,
-- so replays on environments without the job (or without pg_cron) no-op.
do $unschedule$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule('edge-residency-replay')
    where exists (
      select 1 from cron.job where jobname = 'edge-residency-replay'
    );
  end if;
end
$unschedule$;
