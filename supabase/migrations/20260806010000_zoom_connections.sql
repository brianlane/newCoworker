-- Per-business direct Zoom connections (first-party OAuth).
--
-- The Nango-free primary path for Zoom: the owner authorizes our published
-- Zoom Marketplace app ("New Coworker OAuth") through
-- /api/integrations/zoom/connect, and the callback stores the token pair
-- here. Unlike calendly_connections (long-lived PAT) Zoom issues short-lived
-- access tokens with ROTATING refresh tokens, so both tokens plus the expiry
-- are persisted and src/lib/zoom/client.ts refreshes single-flight.
--
-- Legacy Zoom connections made through Nango (workspace_oauth_connections
-- rows with provider_config_key = 'zoom') remain honored by the resolver as
-- a fallback; this table always wins when a row is active.
--
-- Security posture matches calendly_connections / vagaro_connections: RLS
-- on with NO policies (service-role only), tokens AES-256-GCM encrypted at
-- rest via encryptIntegrationSecret (src/lib/integrations/secrets.ts).

create table if not exists public.zoom_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- AES-256-GCM envelopes (`enc:v1:<iv>:<tag>:<ct>`).
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  -- Access-token expiry; the client refreshes when <60s remain.
  token_expires_at timestamptz not null,
  -- Connected account identity captured at connect time (GET /users/me),
  -- shown on the card so the owner can tell WHICH Zoom is linked.
  zoom_user_id text,
  account_email text,
  account_name text,
  -- Soft-disable: set false by the owner OR automatically when a refresh
  -- comes back invalid_grant (revoked/expired) — the card shows "reconnect".
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One direct Zoom connection per business (upsert target).
create unique index if not exists uq_zoom_connections_business
  on public.zoom_connections (business_id);

alter table public.zoom_connections enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").
