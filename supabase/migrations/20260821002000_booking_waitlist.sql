-- Cancellation waitlist ("I'll let you know if a spot opens").
--
-- One live row per (business, customer phone): the customer asked to be told
-- when an EARLIER appointment time opens up. Rows are written by the
-- calendar_join_waitlist coworker tool and the public booking page opt-in;
-- freed slots (cancel tool, reschedule vacating its old start, off-platform
-- cancels observed by the calendar poll / Vagaro webhook) offer the slot to
-- the oldest matching entry over SMS, one candidate at a time with a TTL
-- hold (src/lib/calendar-tools/waitlist-fill.ts).
--
-- Status lifecycle:
--   waiting  -> offered   (offer SMS sent; offer_expires_at set)
--   offered  -> waiting   (offer TTL lapsed; next candidate gets the slot)
--   offered/waiting -> fulfilled (they booked/moved to an earlier time)
--   offered/waiting -> expired   (their linked booking started, or latest_at passed)
--   offered/waiting -> canceled  (they canceled their booking outright)
--
-- Security posture matches calendar_booking_dedupe: RLS on with NO policies
-- (service-role only; anon/authenticated get an unconditional deny).

create table if not exists public.booking_waitlist (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- E.164 customer phone: REQUIRED because offers ride SMS.
  phone text not null,
  email text,
  name text,
  -- Appointment length the customer wants (offer slot = start + duration).
  duration_minutes integer not null default 30,
  -- Window of interest: a freed slot is offered only when it starts at or
  -- after earliest_at and (when set) at or before latest_at.
  earliest_at timestamptz not null default now(),
  latest_at timestamptz,
  -- The booking they already hold (null = no booking yet). A freed slot is
  -- offered only when it starts EARLIER than this; the entry expires when
  -- this start passes.
  current_booking_start_at timestamptz,
  current_event_id text,
  status text not null default 'waiting'
    check (status in ('waiting', 'offered', 'fulfilled', 'expired', 'canceled')),
  -- The pending offer (offered rows only): the held slot plus its TTL.
  offered_start_at timestamptz,
  offered_end_at timestamptz,
  offer_expires_at timestamptz,
  -- Last slot start ever offered to this row: a lapsed offer must pass to
  -- the NEXT candidate, never bounce back to the same person.
  last_offered_start_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The offer scan: live entries per business.
create index if not exists idx_booking_waitlist_biz_status
  on public.booking_waitlist (business_id, status);

-- The sweep: expired offers fleet-wide.
create index if not exists idx_booking_waitlist_offer_expiry
  on public.booking_waitlist (offer_expires_at)
  where status = 'offered';

-- One live entry per (business, phone): joining again updates the window
-- instead of stacking duplicate offers to the same person.
create unique index if not exists uq_booking_waitlist_live_phone
  on public.booking_waitlist (business_id, phone)
  where status in ('waiting', 'offered');

alter table public.booking_waitlist enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").

-- Data API grants are no longer automatic (20260820100400): the app's
-- service-role clients need explicit access.
grant select, insert, update, delete on table public.booking_waitlist to service_role;

-- Owner knobs ride the existing per-business Bookings settings row (a
-- missing row reads as the defaults below, so the waitlist works without
-- the public page ever being enabled).
alter table public.booking_pages
  add column if not exists waitlist_enabled boolean not null default true,
  add column if not exists waitlist_offer_ttl_minutes integer not null default 60;
