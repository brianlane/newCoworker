-- Per-business subscribable calendar-feed tokens.
--
-- The ICS feed (`GET /api/calendar/<ncbf_token>.ics`) renders the booking
-- ledger's upcoming rows as VEVENTs so any calendar app that can subscribe
-- to a URL (Google Calendar, Outlook, Apple Calendar) shows the team what
-- is booked. It is the only team-calendar mechanism that works for EVERY
-- provider: businesses with no Google/Microsoft account cannot host the
-- shared "NewCoworker" calendar at all, and none of the dedicated booking
-- tools (Vagaro, Acuity, Calendly) lets an outside app create a calendar,
-- while iCloud refuses CalDAV MKCALENDAR.
--
-- The token is a plaintext capability, same posture as booking_pages.token
-- (`ncb_`): it ships inside a URL the owner pastes into their calendar app,
-- so it is public by design. It grants nothing beyond reading coarse
-- upcoming booking rows for one business, and it is rotatable, which
-- revokes every previously shared copy at once.
--
-- Service-role only: RLS on with no policies, matching every integration
-- table.

create table if not exists public.calendar_feed_tokens (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  token text not null unique check (token ~ '^ncbf_[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.calendar_feed_tokens enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").

-- Data API grants are NOT automatic since
-- 20260820100400_revoke_default_data_api_grants.sql.
grant select, insert, update, delete on table public.calendar_feed_tokens to service_role;
