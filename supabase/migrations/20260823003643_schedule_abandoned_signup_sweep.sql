-- Schedule the daily abandoned-signup cleanup.
--
-- Signup is "build first, pay last": /api/business/create inserts the
-- businesses row before Stripe is involved, so the questionnaire has
-- somewhere to put the intake and Checkout has a businessId to carry. A
-- session that never pays leaves that row behind forever, because the only
-- existing cascade delete (stale-tenant-cleanup) fires on VPS pool adoption,
-- which a never-provisioned signup can never reach.
--
-- The sweep deletes only rows still carrying the one-way
-- pending+<id>@onboarding.local sentinel, with further guards for status,
-- pinning, VPS linkage, Stripe linkage, white-glove work, customer activity,
-- and a 30-day age floor. Guards and their reasoning live in
-- src/lib/onboarding/abandoned-signup-cleanup.ts, under test at 100%.
--
-- Chain: pg_cron -> Edge abandoned-signup-sweep -> /api/internal/abandoned-signup-sweep
-- Timeouts: 280000 here >= min(maxDuration 150s, bridge 290s, Edge ceiling 150s).
--
-- grants: none (schedule_abandoned_signup_sweep): creates no objects, only a
-- cron schedule.

do $unschedule$
begin
  perform cron.unschedule('edge-abandoned-signup-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-abandoned-signup-sweep'
  );
end
$unschedule$;

-- Daily 04:40 UTC, a quiet slot no other sweep holds.
select cron.schedule(
  'edge-abandoned-signup-sweep',
  '40 4 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/abandoned-signup-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);
