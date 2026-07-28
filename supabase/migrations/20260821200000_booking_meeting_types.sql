-- Meeting types under the booking calendar (the Calendly model).
--
-- One booking page per business stays the unit of shared policy (hours,
-- notice, advance window, buffer, caps, waitlist, reminders). A meeting
-- type is what the VISITOR actually books: "Discovery call, 60 min",
-- "Support call, 30 min, questionnaire, always Ana". Each type owns its
-- duration and gets its own shareable URL (/book/<page>/<typeSlug>) that
-- renders only that meeting, so an owner sharing a discovery-call link
-- never exposes the rest of the catalog.
--
-- Everything nullable here means INHERIT the page: a type with null
-- intake_questions asks the page's questions, a null assignment_mode
-- follows the page's assignment. Zero types = today's behavior exactly
-- (duration picker, page-level questions), so no backfill is needed.
--
-- Security posture matches booking_pages: RLS on with NO policies
-- (service-role only; anon/authenticated get an unconditional deny).

create table if not exists public.booking_meeting_types (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Public name, shown as the event title ("Free Strategy Call").
  name text not null,
  -- URL segment under the page: /book/<page>/<slug>. Same shape as the
  -- page's vanity slug (src/lib/booking-page/keys.ts).
  slug text not null,
  -- Owner-editable blurb for this meeting's left panel; null = the page's.
  description text,
  duration_minutes integer not null,
  -- Null = inherit the page's questions. '[]' means "this type asks
  -- nothing" even when the page has questions, which is why the column is
  -- nullable rather than defaulting to an empty array.
  intake_questions jsonb,
  -- Null = inherit the page's assignment.
  assignment_mode text,
  employee_id uuid references public.ai_flow_team_members(id) on delete set null,
  -- Payment hooks, schema only, same invariant as the page: a type marked
  -- as requiring payment refuses bookings until collection ships.
  payment_required boolean not null default false,
  payment_amount_cents integer,
  payment_currency text not null default 'usd',
  -- Off entirely: the direct link stops working too.
  enabled boolean not null default true,
  -- Reachable by direct link, never listed on the page's picker
  -- (Calendly's "secret event").
  hidden boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.booking_meeting_types
  add constraint booking_meeting_types_duration_chk
    check (duration_minutes between 5 and 480) not valid,
  add constraint booking_meeting_types_assignment_mode_chk
    check (assignment_mode is null or assignment_mode in ('any', 'round_robin', 'fixed'))
    not valid,
  add constraint booking_meeting_types_payment_amount_chk
    check (payment_amount_cents is null or payment_amount_cents between 50 and 5000000)
    not valid,
  add constraint booking_meeting_types_payment_currency_chk
    check (payment_currency in ('usd', 'cad', 'mxn', 'eur', 'gbp')) not valid;

-- The URL segment must be unique WITHIN a business; two tenants may both
-- have "discovery-call" because the page segment disambiguates them.
create unique index if not exists uq_booking_meeting_types_business_slug
  on public.booking_meeting_types (business_id, slug);

-- The dashboard list and the public picker both read by business in order.
create index if not exists idx_booking_meeting_types_business_order
  on public.booking_meeting_types (business_id, sort_order);

alter table public.booking_meeting_types enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").

grant select, insert, update, delete on table public.booking_meeting_types to service_role;

alter table public.calendar_booking_dedupe
  -- Which meeting was booked. Null for AI bookings, for pages with no
  -- types, and for every booking made before types existed. Set null on
  -- delete rather than cascading: deleting a type must never delete the
  -- appointments people already hold.
  add column if not exists meeting_type_id uuid
    references public.booking_meeting_types(id) on delete set null;
