-- Where a booking's mirror event lives on the shared "NewCoworker" calendar.
--
-- The team calendar is how a whole business sees what is booked. Bookings
-- taken on a provider that is NOT the calendar host (Vagaro, Acuity,
-- Calendly, CalDAV) never appear on it, because they are created on the
-- merchant's own book instead. src/lib/calendar-tools/shared-calendar.ts
-- mirrors those onto the host calendar so the team still sees them.
--
-- The mirror needs a handle, or it goes stale the first time a customer
-- reschedules or cancels: a lingering event for an appointment that no
-- longer exists is worse than no mirror at all, because the team acts on it.
-- The ledger row is the only thing that survives across the whole booking
-- lifecycle on these providers, so the handle belongs here.
--
-- Nullable by design. It is null for the providers that ARE the host (their
-- bookings are already on the calendar), for platform-mode bookings, and for
-- any booking made before this shipped.

alter table public.calendar_booking_dedupe
  add column if not exists shared_calendar_event_id text;

-- grants: none (calendar_booking_dedupe): the table already carries its
-- service_role grants from 20260713170513_calendar_booking_dedupe.sql;
-- adding a column does not change them.
