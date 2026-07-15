-- Per-business direct Meta (Facebook) Lead Ads connections.
--
-- The direct alternative to the Zapier/Make/Privyr bridges: the owner clicks
-- "Connect Facebook" on /dashboard/integrations, our platform Meta app
-- (Facebook Login for Business) runs the OAuth dance, and the chosen Page is
-- subscribed to `leadgen` webhooks delivered to /api/webhooks/meta. Inbound
-- leads start `webhook`-channel AiFlows with source "facebook_lead_ads" —
-- the exact payload shape the bridges already send, so existing flows match
-- unchanged.
--
-- Two secrets live here, both AES-256-GCM encrypted at rest via
-- encryptIntegrationSecret (src/lib/integrations/secrets.ts), matching
-- vagaro_connections / calendly_connections:
--   * user_token_encrypted — the long-lived USER token from the OAuth
--     callback. Needed only while the connection is `pending` (to list the
--     user's Pages for the picker); cleared on activation.
--   * page_token_encrypted — the PAGE access token used to fetch lead field
--     data when a leadgen webhook arrives. Page tokens derived from a
--     long-lived user token do not expire, so there is no refresh flow.
--
-- Security posture matches the other direct connections: RLS on with NO
-- policies (service-role only).

create table if not exists public.meta_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- pending: OAuth done, Page not chosen yet. active: Page picked +
  -- leadgen subscribed — the webhook route only serves `active` rows.
  status text not null default 'pending' check (status in ('pending', 'active')),
  -- AES-256-GCM envelope (`enc:v1:<iv>:<tag>:<ct>`); null once activated.
  user_token_encrypted text,
  -- The connected Facebook Page (null while pending).
  page_id text,
  page_name text,
  -- AES-256-GCM envelope; null while pending.
  page_token_encrypted text,
  -- The Facebook account that authorized the connection (shown on the card).
  account_name text,
  -- Soft-disable: the row stays for audit; webhook deliveries refuse while
  -- inactive.
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One direct Meta connection per business (upsert target).
create unique index if not exists uq_meta_connections_business
  on public.meta_connections (business_id);

-- A Page routes webhooks to exactly one tenant: two businesses may not hold
-- the same Page in the connected state at once.
create unique index if not exists uq_meta_connections_page
  on public.meta_connections (page_id)
  where page_id is not null and is_active;

alter table public.meta_connections enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").
