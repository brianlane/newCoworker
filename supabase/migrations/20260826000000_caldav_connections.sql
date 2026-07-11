-- Per-business direct CalDAV calendar connections (iCloud, Nextcloud, any
-- generic CalDAV server) — concept ported from BizBlasts' Calendar::CaldavService.
--
-- The owner pastes their CalDAV server URL, username, and an app-specific
-- password on the dashboard card (for iCloud: appleid.apple.com → App-Specific
-- Passwords, server https://caldav.icloud.com). Calendar tools then run real
-- free/busy searches and create events over the CalDAV protocol directly
-- (src/lib/caldav/client.ts) — no OAuth app, no Nango.
--
-- Security posture matches calendly_connections / vagaro_connections: RLS on
-- with NO policies (service-role only), password AES-256-GCM encrypted at
-- rest via encryptIntegrationSecret (src/lib/integrations/secrets.ts).

create table if not exists public.caldav_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- CalDAV root, e.g. https://caldav.icloud.com (https only; validated
  -- against private/loopback hosts before storage).
  server_url text not null,
  username text not null,
  -- AES-256-GCM envelope (`enc:v1:<iv>:<tag>:<ct>`).
  password_encrypted text not null,
  -- Discovered at verify time so tool calls skip the 3-step discovery walk:
  -- the event calendar bookings land on / busy is read from.
  calendar_url text,
  calendar_name text,
  -- Soft-disable: the row stays for audit; tools refuse while inactive.
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One direct CalDAV connection per business (upsert target).
create unique index if not exists uq_caldav_connections_business
  on public.caldav_connections (business_id);

alter table public.caldav_connections enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").

comment on table public.caldav_connections is
  'Direct CalDAV calendar connections (iCloud app-specific password etc.). Service-role only; password encrypted at rest.';
