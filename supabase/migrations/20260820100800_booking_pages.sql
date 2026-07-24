-- Public self-serve booking page (native, per-tenant).
--
-- One row per business: an unguessable capability token (the /book/<token>
-- URL is fully public, no login) plus the availability policy knobs the
-- slot search applies on top of real calendar free/busy. Policy set
-- borrowed from BizBlasts' field-tested BookingPolicy model (min notice,
-- max advance, buffer, daily cap).
--
-- The token is PUBLIC by design (it ships in links the owner hands out),
-- so it is stored in plaintext like the webchat site key; possession
-- grants nothing beyond "list coarse slot starts and submit one booking
-- request" — rate limits and the slot re-verify are the real controls.
--
-- Security posture matches calendly_connections: RLS on with NO policies
-- (service-role only; anon/authenticated get an unconditional deny).

create table if not exists public.booking_pages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- `ncb_<64 hex>` capability token (src/lib/booking-page/keys.ts).
  token text not null,
  enabled boolean not null default false,
  -- Durations (minutes) the visitor can pick from.
  allowed_durations integer[] not null default '{15,30}',
  -- Earliest bookable start is now + min_notice_minutes.
  min_notice_minutes integer not null default 120,
  -- Latest bookable day is today + max_advance_days (business-local).
  max_advance_days integer not null default 14,
  -- Idle padding enforced between a slot and adjacent busy blocks.
  buffer_minutes integer not null default 0,
  -- Max platform bookings per business-local day; null = uncapped.
  max_daily_bookings integer,
  -- When true, slots require at least one roster member on shift
  -- (weekly_schedule / employee_time_off via the AiFlow engine evaluators).
  require_staff_on_shift boolean not null default false,
  -- Owner-editable blurb rendered on the public page's left panel.
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One page per business (upsert target).
create unique index if not exists uq_booking_pages_business
  on public.booking_pages (business_id);

-- O(1) public-token resolution.
create unique index if not exists uq_booking_pages_token
  on public.booking_pages (token);

alter table public.booking_pages enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").

-- Data API grants are no longer automatic (20260820100400): the app's
-- service-role clients need explicit access.
grant select, insert, update, delete on table public.booking_pages to service_role;
