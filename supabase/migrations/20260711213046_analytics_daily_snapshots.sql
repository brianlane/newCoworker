-- Daily analytics snapshots (concept ported from BizBlasts' AnalyticsSnapshot
-- + daily_snapshot_job).
--
-- One row per (business, UTC day) holding aggregate activity counters,
-- written by the nightly analytics-snapshot-sweep (pg_cron → Edge →
-- /api/internal/analytics-snapshot-sweep). Two problems this solves that
-- recompute-on-render cannot:
--   1. Trend windows beyond 30 days without the transcript scan cap
--      (ANALYTICS_CALL_SCAN_LIMIT) clipping the numbers.
--   2. Analytics history SURVIVES retention pruning — the cards read raw
--      transcripts today, so a tenant with data_retention_days=30 loses all
--      analytics past the window. Aggregates hold no content (counts only),
--      so they are retention- and residency-safe (central table, no
--      moved-table routing).
--
-- Security posture: RLS on with NO policies (service-role only), like every
-- other analytics-adjacent table.

create table if not exists public.analytics_daily_snapshots (
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- UTC calendar day the counters describe (same bucketing as the volume
  -- series on /dashboard/analytics).
  snapshot_date date not null,
  -- Answered calls, both directions (volume-series population).
  calls integer not null default 0,
  -- Inbound answered (answer-rate population).
  inbound_calls integer not null default 0,
  -- Wall-clock call minutes (activity measure, not the billing ledger).
  voice_minutes integer not null default 0,
  -- Metered outbound texts (daily_usage.sms_sent as of the sweep).
  sms_sent integer not null default 0,
  -- Inbound refusals (voice_call_blocked ledger).
  missed_calls integer not null default 0,
  -- Sentiment mix across the day's summarized inbound calls.
  sentiment_positive integer not null default 0,
  sentiment_neutral integer not null default 0,
  sentiment_negative integer not null default 0,
  sentiment_mixed integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, snapshot_date)
);

alter table public.analytics_daily_snapshots enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").

comment on table public.analytics_daily_snapshots is
  'Per-business per-UTC-day activity aggregates (counts only, no content). Written nightly by analytics-snapshot-sweep; feeds long-window trends + forecasts that survive retention pruning.';

-- ---------------------------------------------------------------------------
-- Nightly sweep schedule: pg_cron → Edge analytics-snapshot-sweep.
-- 02:50 UTC — after the day is final everywhere the fleet operates and off
-- the top-of-hour spike; before the 04:00+ maintenance crons.
-- ---------------------------------------------------------------------------
do
$unschedule$
begin
  perform cron.unschedule('edge-analytics-snapshot-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-analytics-snapshot-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-analytics-snapshot-sweep',
  '50 2 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/analytics-snapshot-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);
