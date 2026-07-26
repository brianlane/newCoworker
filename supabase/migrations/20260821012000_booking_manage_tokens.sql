-- Invitee self-serve manage links for public-page bookings.
--
-- A visitor who books through /book/<ref> had no way to move or cancel
-- without texting the business: every change went through a human, or
-- through the AI coworker on another channel. These columns back
-- /book/manage/<manage_token>, the Calendly-style "reschedule or cancel"
-- link that rides the confirmation.
--
-- Scope note: only bookings MADE on the public page get a token (the page
-- stamps it). AI-made bookings keep behaving exactly as before, so this
-- cannot change what a voice or SMS booking looks like.

alter table public.calendar_booking_dedupe
  -- `ncbm_<64 hex>` capability token (src/lib/booking-page/keys.ts). Public
  -- by design like the page token: it grants "see, move, or cancel THIS
  -- booking" and nothing else.
  add column if not exists manage_token text,
  -- Slot length the visitor picked, so a reschedule can offer the same
  -- duration without guessing (the ledger only ever stored the start).
  add column if not exists duration_minutes integer;

-- One booking per token; partial so the many token-less AI bookings do not
-- collide on null.
create unique index if not exists uq_calendar_booking_dedupe_manage_token
  on public.calendar_booking_dedupe (manage_token)
  where manage_token is not null;

-- No grants needed: calendar_booking_dedupe already grants service_role,
-- and these are columns on it, not new objects.
