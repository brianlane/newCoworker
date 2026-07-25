-- Last-known-good provider busy cache for the public booking page.
--
-- Written through on every SUCCESSFUL provider free/busy fetch; read only
-- when a live fetch fails (stale-while-error). Converts a provider outage
-- from "previously busy times become bookable" (double-booking window)
-- into "availability freezes at the last snapshot": a time the provider
-- reported busy stays blocked through the outage, bounded by a staleness
-- TTL enforced app-side (src/lib/booking-page/busy-cache.ts).
--
-- One row per business; spans are absolute-instant ISO pairs. Not tenant
-- content (derived availability data), so it is outside the residency
-- moved-tables set. RLS on with NO policies (service-role only).

create table if not exists public.booking_busy_cache (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  -- Array of { "start": iso, "end": iso } spans from the last good fetch.
  busy jsonb not null default '[]',
  window_start timestamptz not null,
  window_end timestamptz not null,
  fetched_at timestamptz not null default now()
);

alter table public.booking_busy_cache enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").

grant select, insert, update, delete on table public.booking_busy_cache to service_role;
