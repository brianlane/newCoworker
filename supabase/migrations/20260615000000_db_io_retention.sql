-- Disk-IO hygiene: the two biggest sources of avoidable IO found in the
-- 2026-06 diagnosis were
--   1. cron.job_run_details — 73 MB of history with no retention. pg_cron
--      writes 2 rows per job run (~10 jobs/minute here) and its startup
--      "mark stale runs failed" UPDATE was the single largest IO consumer
--      in pg_stat_statements (12.6k blocks in one call).
--   2. telemetry_events — 30 MB with ~100 live rows; telemetry_prune_events()
--      has existed since the voice platform migration but was never
--      scheduled.
-- Both get a daily prune cron. The one-off VACUUM FULL to reclaim the
-- already-bloated space cannot run in a migration transaction and is done
-- manually at deploy time.

-- 1) cron.job_run_details retention: keep 2 days of history. That is
-- plenty for debugging missed runs (system_logs carries the durable
-- application-level audit trail).
do
$unschedule$
begin
  perform cron.unschedule('cron-history-prune')
  where exists (select 1 from cron.job where jobname = 'cron-history-prune');
end
$unschedule$;

select cron.schedule(
  'cron-history-prune',
  -- 04:40 UTC daily, offset from system-logs-prune (04:20) and the other
  -- top-of-hour crons.
  '40 4 * * *',
  $$ delete from cron.job_run_details where end_time < now() - interval '2 days'; $$
);

-- 2) telemetry_events retention: 30 days is generous for counter-style
-- events that nothing reads after the fact today.
do
$unschedule$
begin
  perform cron.unschedule('telemetry-events-prune')
  where exists (select 1 from cron.job where jobname = 'telemetry-events-prune');
end
$unschedule$;

select cron.schedule(
  'telemetry-events-prune',
  '50 4 * * *',
  $$ select telemetry_prune_events(interval '30 days'); $$
);
