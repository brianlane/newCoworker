-- Monthly growth recap email: one message per owner per month, about the
-- month that just ended, showing what the coworker actually handled and which
-- way the line is pointing.
--
-- Call chain:
--   pg_cron -> net.http_post -> Edge `monthly-growth-sweep`
--                            -> Next.js POST /api/internal/monthly-growth-sweep
--
-- Security model mirrors 20260822003140_monthly_intro_nudge.sql: Bearer from
-- Vault (`internal_cron_secret`) via public._cron_vault_read, Edge base URL
-- from Vault (`edge_base_url`).
--
-- grants: none (monthly_growth_email): adds a column to public.businesses,
-- which already carries its service_role grants; no new object is created.

-- Which month's recap has already gone out, as "YYYY-MM". Claimed BEFORE the
-- send with a conditional update, so two overlapping ticks cannot both win
-- and a crash mid-send drops that month rather than duplicating it.
--
-- A month string and not a timestamp on purpose: the question the sweep asks
-- is "has THIS month been reported?", and a timestamp would have to be
-- re-derived into a month on every read, which is where an off-by-one
-- timezone bug would live.
alter table public.businesses
  add column if not exists monthly_growth_email_sent_for text null;

comment on column public.businesses.monthly_growth_email_sent_for is
  'Calendar month ("YYYY-MM") whose growth recap email has been claimed/sent to this owner. Null until the first send. Claim-before-send, see src/lib/analytics/monthly-growth-sweep.ts.';

-- The sweep scans every business and decides per row, so the only index worth
-- having is the one that makes "not yet sent for this month" cheap as the
-- fleet grows.
create index if not exists businesses_monthly_growth_email_idx
  on public.businesses (monthly_growth_email_sent_for);

do $unschedule$
begin
  perform cron.unschedule('edge-monthly-growth-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-monthly-growth-sweep'
  );
end
$unschedule$;

-- Daily at 16:20 UTC (~9:20am Phoenix), offset from the other daily sweeps.
--
-- Daily rather than monthly even though it sends monthly: the sweep itself
-- refuses to send before the 3rd (GROWTH_EMAIL_SEND_DAY) and stamps the month
-- once it has, so a daily tick is a free retry for any tenant whose send
-- failed, while a single monthly tick would lose that month entirely on one
-- bad morning.
select cron.schedule(
  'edge-monthly-growth-sweep',
  '20 16 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/monthly-growth-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);
