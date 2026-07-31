-- Per-business Acuity Scheduling (Squarespace) API connections.
--
-- Acuity issues each merchant a User ID + API Key from their own
-- Integrations settings, used as HTTP Basic credentials against
-- https://acuityscheduling.com/api/v1/. Unlike Vagaro there is NO token
-- exchange: the key IS the credential, so src/lib/acuity/client.ts sends a
-- static Authorization: Basic header. The same API key is ALSO the shared
-- secret Acuity signs webhooks with (base64 HMAC-SHA256 over the raw body,
-- x-acuity-signature), which is why the direct-credential path is the right
-- one here even though Acuity also offers OAuth.
--
-- Used for:
--   1. calendar tools — availability search + appointment create / reschedule
--      / cancel, so the voice/SMS coworker books REAL Acuity appointments;
--   2. verifying the owner's credentials at connect time (GET /me) and
--      listing appointment types + calendars for the dashboard card;
--   3. verifying inbound webhook signatures.
--
-- Security posture matches vagaro_connections / custom_integrations: RLS on
-- with NO policies (service-role only), and the API key is AES-256-GCM
-- ciphertext at rest via encryptIntegrationSecret
-- (src/lib/integrations/secrets.ts), so a DB dump alone exposes nothing.

create table if not exists public.acuity_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Acuity's numeric User ID, stored as text (it is an opaque credential
  -- half, never arithmetic).
  user_id text not null check (length(trim(user_id)) between 1 and 64),
  -- AES-256-GCM envelope (`enc:v1:<iv>:<tag>:<ct>`), same crypto module as
  -- vagaro_connections.client_secret_encrypted.
  api_key_encrypted text not null,
  -- Bare https origin only; the /api/v1 path is a client constant so this
  -- validator stays identical to Vagaro's. Always https, enforced here and
  -- revalidated in app code.
  api_base_url text not null default 'https://acuityscheduling.com'
    check (api_base_url ~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?$'),
  -- Random bearer embedded in the tenant's webhook URL. Acuity's HMAC over
  -- the body is the real authentication; this is defense in depth so
  -- unsigned junk never reaches the signature check or the body parse.
  webhook_verification_token text not null,
  -- Booking defaults chosen on the dashboard card: which appointment type
  -- and staff calendar calendar_book_appointment uses when the model does
  -- not name one.
  default_appointment_type_id text,
  default_calendar_id text,
  -- An Acuity calendar carries its own timezone, which can differ from the
  -- business timezone. Cached at connect time so the booking hot path never
  -- calls GET /calendars just to resolve a zone.
  default_calendar_timezone text,
  -- Pass noEmail=true on create/reschedule/cancel so Acuity does not send a
  -- second confirmation on top of the platform's own. Owners who prefer
  -- Acuity's branded mail turn this off.
  suppress_provider_emails boolean not null default true,
  -- Dynamic webhook registration state: { ids, targetUrl, registeredAt,
  -- status }. `status` is 'registered' | 'unsupported' | 'cap_reached':
  -- Acuity allows only 25 webhooks per account and returns 400 at the cap,
  -- and registration may be OAuth-only on some plans, so both degraded
  -- outcomes are first-class and the card falls back to "paste this URL".
  webhook_registration jsonb not null default '{}'::jsonb,
  -- Soft-disable: the row (and its webhook token) stays for audit, but
  -- calendar tools + webhook deliveries refuse while inactive.
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One Acuity connection per business (upsert target).
create unique index if not exists uq_acuity_connections_business
  on public.acuity_connections (business_id);

alter table public.acuity_connections enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").

-- Data API grants are NOT automatic since
-- 20260820100400_revoke_default_data_api_grants.sql. Without this, every
-- supabase-js read of this table fails at runtime with "permission denied"
-- even under the service-role key.
grant select, insert, update, delete on table public.acuity_connections to service_role;
