-- Raise the term-renewal sweep's pg_cron HTTP timeout from 800s to 1800s.
--
-- PR #1014 raised the Next route to maxDuration = 1800 and the Edge bridge to
-- REQUEST_TIMEOUT_MS = 1_800_000, and rescheduled edge-provisioning-watchdog to
-- timeout_milliseconds := 1800000 in 20260822002126. edge-vps-term-renewal-sweep
-- was left at 800000, so pg_cron hangs up on it roughly 16 minutes before the
-- work is allowed to finish.
--
-- The Next function keeps running after the bridge disconnects, so this is log
-- noise rather than a truncated migration: every sweep is recorded as a timeout
-- in cron.job_run_details, which makes a genuine timeout impossible to spot.
--
-- Schedule and body are otherwise carried over verbatim from
-- 20260821225221_schedule_vps_term_renewal_sweep.sql.
--
-- grants: none (cron schedule only; creates no objects).

select cron.unschedule('edge-vps-term-renewal-sweep')
where exists (
  select 1 from cron.job where jobname = 'edge-vps-term-renewal-sweep'
);

select cron.schedule(
  'edge-vps-term-renewal-sweep',
  '0 11 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/vps-term-renewal-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 1800000
  );
  $$
);
