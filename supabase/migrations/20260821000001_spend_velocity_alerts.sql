-- Gemini spend-velocity alert (admin watchdog).
--
-- Why: the shared AI spend fuse (owner_chat_model_spend) is a PER-PERIOD
-- cap — it says nothing about HOW FAST budget is burning. A runaway surface
-- (e.g. the public marketing-site chat widget getting hammered) could eat a
-- whole month's budget in an hour and only degrade to the local model after
-- the fact. This adds a rolling-window velocity check: when any business's
-- combined Gemini spend rises by more than an admin-configured amount
-- (default $3) within an admin-configured window (default 120 minutes),
-- the platform admin gets an email.
--
-- Mechanics (no hot-path writes): a pg_cron job invokes the
-- `chat-spend-velocity-alerts` Edge function every 10 minutes. It snapshots
-- every business's current period spend into
-- chat_spend_velocity_snapshots, computes
-- `current - min(snapshot within window, same period)` per business, and
-- emails the admin on breach — deduped via chat_spend_velocity_alerts (at
-- most one alert per business per window). Snapshots are pruned after 48h.
--
-- All three tables are RLS-on / no-policies (service-role only) — same
-- posture as the other operational tables.

-- ---------------------------------------------------------------------
-- Generic admin platform settings (key → jsonb). First key:
-- 'chat_spend_velocity_alert' → { enabled, threshold_micros,
-- window_minutes }. Editable from Admin → System; read by the Edge
-- function each run so changes take effect without a redeploy.
-- ---------------------------------------------------------------------
create table if not exists admin_platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table admin_platform_settings enable row level security;

comment on table admin_platform_settings is
  'Platform-admin configuration knobs (key → jsonb). RLS on, no policies: service-role only. Written by /api/admin/* routes after requireAdmin; read by Edge crons.';

-- Seed the velocity-alert config with the requested defaults: enabled,
-- $3 (3,000,000 micro-USD) per 120 minutes.
insert into admin_platform_settings (key, value)
values (
  'chat_spend_velocity_alert',
  '{"enabled": true, "threshold_micros": 3000000, "window_minutes": 120}'::jsonb
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Rolling spend snapshots (one row per business per cron tick).
-- period_start is carried so a month/billing rollover (spend resets to a
-- new row) never produces a negative or cross-period delta.
-- ---------------------------------------------------------------------
create table if not exists chat_spend_velocity_snapshots (
  id bigint generated always as identity primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  period_start timestamptz not null,
  spend_micros bigint not null,
  captured_at timestamptz not null default now()
);

create index if not exists idx_spend_velocity_snapshots_business
  on chat_spend_velocity_snapshots (business_id, captured_at desc);

-- Prune sweep: delete-by-age.
create index if not exists idx_spend_velocity_snapshots_captured
  on chat_spend_velocity_snapshots (captured_at);

alter table chat_spend_velocity_snapshots enable row level security;

comment on table chat_spend_velocity_snapshots is
  'Per-tick snapshots of owner_chat_model_spend used to compute rolling-window Gemini spend velocity. Written/pruned by the chat-spend-velocity-alerts Edge cron. RLS on, no policies.';

-- ---------------------------------------------------------------------
-- Alert log — the audit trail AND the dedupe guard (at most one alert
-- per business per rolling window).
-- ---------------------------------------------------------------------
create table if not exists chat_spend_velocity_alerts (
  id bigint generated always as identity primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  delta_micros bigint not null,
  threshold_micros bigint not null,
  window_minutes int not null,
  alerted_at timestamptz not null default now()
);

create index if not exists idx_spend_velocity_alerts_business
  on chat_spend_velocity_alerts (business_id, alerted_at desc);

alter table chat_spend_velocity_alerts enable row level security;

comment on table chat_spend_velocity_alerts is
  'Sent Gemini spend-velocity alerts (audit + per-business per-window dedupe). RLS on, no policies.';

-- ---------------------------------------------------------------------
-- Schedule: every 10 minutes. Same vault-read security model as the
-- other edge crons (rotating the secret needs no migration).
-- ---------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $unschedule$
begin
  perform cron.unschedule('edge-chat-spend-velocity-alerts')
  where exists (
    select 1 from cron.job where jobname = 'edge-chat-spend-velocity-alerts'
  );
end
$unschedule$;

select cron.schedule(
  'edge-chat-spend-velocity-alerts',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/chat-spend-velocity-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
