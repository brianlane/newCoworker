-- Per-business Vagaro API connections.
--
-- Vagaro issues each merchant a Client ID / Client Secret (OAuth2
-- client-credentials) from their APIs & Webhooks settings. The platform
-- exchanges those for short-lived access tokens server-side
-- (src/lib/vagaro/client.ts) and uses them for:
--   1. calendar tools — availability search + appointment creation, so the
--      voice/SMS coworker books REAL Vagaro appointments;
--   2. verifying the owner's credentials at connect time (service listing).
--
-- Inbound events skip Zapier entirely: the owner pastes the per-tenant
-- webhook URL (which embeds `webhook_verification_token`) into Vagaro's
-- webhook settings, and /api/webhooks/vagaro feeds the AiFlow webhook
-- trigger channel + the contact sync.
--
-- Security posture matches custom_integrations: RLS on with NO policies
-- (service-role only), and the client secret is AES-256-GCM ciphertext at
-- rest via encryptIntegrationSecret (src/lib/integrations/secrets.ts) — a
-- DB dump alone exposes nothing.

create table if not exists public.vagaro_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  client_id text not null check (length(trim(client_id)) between 1 and 200),
  -- AES-256-GCM envelope (`enc:v1:<iv>:<tag>:<ct>`), same crypto module as
  -- custom_integrations.secret_encrypted.
  client_secret_encrypted text not null,
  -- Vagaro routes API traffic per data center; the owner supplies the base
  -- URL shown in their developer settings (defaults to the US API host).
  -- Always https — enforced here and revalidated in app code.
  api_base_url text not null default 'https://api.vagaro.com'
    check (api_base_url ~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?$'),
  -- Random bearer embedded in the tenant's webhook URL; Vagaro echoes the
  -- URL verbatim, so possession of the token authenticates the delivery.
  webhook_verification_token text not null,
  -- Booking defaults: which service/employee `calendar_book_appointment`
  -- books when the model doesn't specify one. Chosen on the dashboard card.
  default_service_id text,
  default_employee_id text,
  -- Soft-disable: the row (and its webhook token) stays for audit, but
  -- calendar tools + webhook deliveries refuse while inactive.
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One Vagaro connection per business (upsert target).
create unique index if not exists uq_vagaro_connections_business
  on public.vagaro_connections (business_id);

alter table public.vagaro_connections enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").
