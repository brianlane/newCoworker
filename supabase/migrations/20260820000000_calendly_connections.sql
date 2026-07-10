-- Per-business direct Calendly connections (Personal Access Token).
--
-- The Nango OAuth path for Calendly requires the platform to register a
-- Calendly OAuth app and enable the integration in the Nango dashboard.
-- This table is the zero-setup alternative, mirroring vagaro_connections:
-- the owner pastes a Calendly Personal Access Token (Calendly →
-- Integrations & apps → API & webhooks → personal access tokens) on the
-- dashboard card, and the calendar tools talk to api.calendly.com
-- directly with it (src/lib/calendly/client.ts). PATs are long-lived
-- bearer tokens — no refresh flow.
--
-- Security posture matches vagaro_connections / custom_integrations: RLS
-- on with NO policies (service-role only), token AES-256-GCM encrypted at
-- rest via encryptIntegrationSecret (src/lib/integrations/secrets.ts).

create table if not exists public.calendly_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- AES-256-GCM envelope (`enc:v1:<iv>:<tag>:<ct>`).
  access_token_encrypted text not null,
  -- Connected account identity captured at verify time (GET /users/me),
  -- shown on the card so the owner can tell WHICH Calendly is linked.
  account_name text,
  account_email text,
  -- Soft-disable: the row stays for audit; tools refuse while inactive.
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One direct Calendly connection per business (upsert target).
create unique index if not exists uq_calendly_connections_business
  on public.calendly_connections (business_id);

alter table public.calendly_connections enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").
