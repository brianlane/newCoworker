-- Move the fleet orphan sweep ahead of the billing-posture check.
--
-- The sweep was scheduled at 14:00 UTC, an hour AFTER billing posture at
-- 13:00. Both read vps_inventory, and the sweep is the thing that writes the
-- rows posture then complains about the absence of: an untracked VM the sweep
-- pools at 14:00 is still reported as untracked by the 13:00 run that already
-- happened, so every newly-found orphan costs one extra day of ACTION
-- REQUIRED noise before it clears.
--
-- Running the sweep first makes the pool current before posture reads it, so
-- a box found and pooled on day N is quiet on day N rather than day N+1. It
-- also lets posture validate the freshly pooled box's auto-renew state in the
-- same cycle instead of a day later.
--
-- 12:00 UTC, an hour before posture, matching the spacing posture already has
-- from the term-renewal sweep at 11:00. Timeout and target unchanged from
-- 20260822021611_schedule_vps_orphan_sweep.sql; only the hour moves.
--
-- grants: none (cron reschedule only; creates no objects).

do $unschedule$
begin
  perform cron.unschedule('edge-vps-orphan-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-vps-orphan-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-vps-orphan-sweep',
  '0 12 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/vps-orphan-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    -- Must not hang up before the route's maxDuration (300s) elapses, or a
    -- clean run is recorded as a cron timeout and a real one becomes
    -- invisible. Guarded by tests/cron-timeout-parity.test.ts.
    timeout_milliseconds := 360000
  );
  $$
);
