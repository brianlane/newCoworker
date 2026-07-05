-- Public API + Zapier foundation.
--
-- Two tables power the tenant-facing REST API (/api/public/v1/*) and its
-- Zapier app:
--
--   * api_keys — per-business bearer credentials. Only a SHA-256 hash is
--     stored; the plaintext (`nck_<64 hex>`) is shown once at mint time.
--     `key_prefix` keeps the first characters so owners can tell keys apart
--     in the dashboard without us retaining the secret.
--
--   * webhook_subscriptions — Zapier-style REST hooks. A subscription is a
--     (business, event, target_url) row; the webhook-dispatcher Edge cron
--     polls each source table for rows newer than `last_cursor` and POSTs
--     them to `target_url`. Cursor-per-subscription (rather than a delivery
--     outbox) keeps the pipeline idempotent and self-healing: a failed tick
--     simply doesn't advance the cursor and the next tick retries.
--
-- Both tables are service-role only (no owner RLS policies): every access
-- path goes through the Next.js API layer, which scopes by the
-- authenticated owner / API key.

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null default 'API key',
  key_prefix text not null,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index api_keys_business_idx on public.api_keys (business_id);

alter table public.api_keys enable row level security;

comment on table public.api_keys is
  'Hashed bearer credentials for the public REST API (/api/public/v1/*). Plaintext shown once at mint.';

create table public.webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  event text not null check (event in ('sms.inbound', 'sms.outbound', 'call.completed', 'email.inbound')),
  target_url text not null,
  active boolean not null default true,
  -- Delivery cursor: a (timestamp, id) TUPLE over the event's cursor column
  -- (created_at, or ended_at for call.completed). Rows strictly after the
  -- tuple have not been delivered yet; the id tiebreak means two events
  -- sharing a timestamp can never shadow each other. Seeded to the
  -- subscription creation time so a new hook never replays history.
  last_cursor timestamptz not null default now(),
  last_cursor_id uuid not null default '00000000-0000-0000-0000-000000000000',
  consecutive_failures integer not null default 0,
  -- Dispatch lease: a tick claims the subscription by setting this into the
  -- future and releases it (null) with the cursor update. An overlapping
  -- cron run finds the lease held and skips, so the same rows are never
  -- POSTed twice; a crashed tick's lease simply expires.
  locked_until timestamptz,
  api_key_id uuid references public.api_keys(id) on delete set null,
  created_at timestamptz not null default now()
);

create index webhook_subscriptions_active_idx
  on public.webhook_subscriptions (active, event);
create index webhook_subscriptions_business_idx
  on public.webhook_subscriptions (business_id);

alter table public.webhook_subscriptions enable row level security;

comment on table public.webhook_subscriptions is
  'Zapier-style REST hooks: the webhook-dispatcher Edge cron POSTs new events (cursor-based) to target_url.';

-- The public API''s send-SMS action logs with its own source label so owner
-- dashboards and audits can tell an API/Zapier send from a human one.
alter table public.sms_outbound_log
  drop constraint if exists sms_outbound_log_source_check;

alter table public.sms_outbound_log
  add constraint sms_outbound_log_source_check
  check (source in ('ai_flow', 'agent_offer', 'owner_notify', 'owner_manual', 'api'));

comment on column public.sms_outbound_log.source is
  'ai_flow | agent_offer | owner_notify | owner_manual (dashboard compose) | api (public API / Zapier)';
