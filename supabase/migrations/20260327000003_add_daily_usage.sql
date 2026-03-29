-- Daily usage tracking for tier limit enforcement
-- Tracks voice minutes, SMS, and calls per business per day
-- Used to enforce Starter tier limits (60 min voice, 100 SMS, 10 calls/day)

create table if not exists daily_usage (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  usage_date date not null default current_date,
  voice_minutes_used integer not null default 0,
  sms_sent integer not null default 0,
  calls_made integer not null default 0,
  peak_concurrent_calls integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(business_id, usage_date)
);

-- RLS: owner reads own usage; service role writes (Rowboat via service key)
alter table daily_usage enable row level security;

create policy "Owner reads own usage"
  on daily_usage for select
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

create policy "Service role manages usage"
  on daily_usage for all
  using (auth.role() = 'service_role');

-- Fast index for per-business daily limit checks
create index if not exists idx_daily_usage_biz_date
  on daily_usage(business_id, usage_date);
