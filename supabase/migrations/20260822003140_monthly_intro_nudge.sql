-- One-time month-to-month intro nudge: email owners 5 business days before
-- their first renewal that the intro rate ends, and list 12/24-month options.
--
-- Call chain:
--   pg_cron → net.http_post → Edge `monthly-intro-nudge-sweep`
--                            → Next.js POST /api/internal/monthly-intro-nudge-sweep
--
-- Security model mirrors 20260711221501_schedule_document_expiration_sweep.sql:
-- Bearer from Vault (`internal_cron_secret`) via public._cron_vault_read,
-- Edge base URL from Vault (`edge_base_url`).

alter table public.subscriptions
  add column if not exists monthly_intro_nudge_sent_at timestamptz null;

comment on column public.subscriptions.monthly_intro_nudge_sent_at is
  'When the first-month month-to-month intro price-increase nudge email was claimed/sent. Null until the daily sweep stamps it (claim-before-send).';

-- Sweep scan: active monthly subs that have not been nudged yet, ordered by
-- period end. billing_paused / cancel_at_period_end / first-cycle checks stay
-- in app code so the index stays simple.
create index if not exists subscriptions_monthly_intro_nudge_scan_idx
  on public.subscriptions (stripe_current_period_end)
  where billing_period = 'monthly'
    and status = 'active'
    and monthly_intro_nudge_sent_at is null;

do $unschedule$
begin
  perform cron.unschedule('edge-monthly-intro-nudge-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-monthly-intro-nudge-sweep'
  );
end
$unschedule$;

-- Daily 15:15 UTC (~ mid-morning US), offset from other daily sweeps.
select cron.schedule(
  'edge-monthly-intro-nudge-sweep',
  '15 15 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/monthly-intro-nudge-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);
