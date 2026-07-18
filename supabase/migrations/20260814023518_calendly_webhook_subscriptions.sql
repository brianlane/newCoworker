-- Per-business Calendly webhook subscriptions (invitee.created fast path).
--
-- The polling booking-goal sweep (src/lib/ai-flows/calendly-booking-goals.ts)
-- observes Calendly bookings with ~1-2 min latency. Calendly also offers
-- real-time webhook subscriptions — a PAID Calendly feature, created via
-- POST /webhook_subscriptions. This table records the platform's attempt to
-- enable that fast path per business: the subscription URI, the
-- per-subscription signing key Calendly returns ONCE at creation (used to
-- verify the Calendly-Webhook-Signature header on /api/webhooks/calendly),
-- and the attempt status so free-plan tenants are not re-tried every tick.
-- The sweep keeps running for everyone — the webhook only cuts latency.
--
-- Security posture matches calendly_connections: RLS on with NO policies
-- (service-role only), signing key AES-256-GCM encrypted at rest via
-- encryptIntegrationSecret (src/lib/integrations/secrets.ts).

create table if not exists public.calendly_webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- 'active'      — subscription exists; receiver verifies with signing key.
  -- 'unsupported' — Calendly refused (free plan / missing permission);
  --                 retried on a long cooldown in case the tenant upgrades.
  -- 'error'       — transient failure; retried on the same cooldown.
  status text not null check (status in ('active', 'unsupported', 'error')),
  -- Canonical Calendly resource URI (null unless status = 'active').
  subscription_uri text,
  -- AES-256-GCM envelope (`enc:v1:<iv>:<tag>:<ct>`); null unless active.
  signing_key_encrypted text,
  last_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One subscription row per business (upsert target).
create unique index if not exists uq_calendly_webhook_subscriptions_business
  on public.calendly_webhook_subscriptions (business_id);

alter table public.calendly_webhook_subscriptions enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").

comment on table public.calendly_webhook_subscriptions is
  'Per-business Calendly webhook subscription state (invitee.created fast path for appointment_booked goal events). Signing key encrypted at rest; service-role only.';
