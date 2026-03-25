create table if not exists businesses (
  id uuid primary key,
  name text not null,
  owner_email text not null,
  tier text not null check (tier in ('starter', 'standard', 'enterprise')),
  status text not null check (status in ('online', 'offline', 'high_load')),
  hostinger_vps_id text,
  created_at timestamptz not null default now()
);

create table if not exists business_configs (
  business_id uuid primary key references businesses(id) on delete cascade,
  soul_md text not null,
  identity_md text not null,
  memory_md text not null,
  updated_at timestamptz not null default now()
);

create table if not exists coworker_logs (
  id uuid primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  task_type text not null,
  status text not null,
  log_payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  id uuid primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  channel text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists notifications (
  id uuid primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  delivery_channel text not null check (delivery_channel in ('sms', 'email', 'dashboard')),
  status text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists subscriptions (
  id uuid primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  tier text not null check (tier in ('starter', 'standard', 'enterprise')),
  status text not null,
  created_at timestamptz not null default now()
);
