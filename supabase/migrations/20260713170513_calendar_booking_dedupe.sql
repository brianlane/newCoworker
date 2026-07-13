-- Calendar booking idempotency ledger.
--
-- Incident (Truly Insurance, 2026-07-13): a transient Gemini "Service
-- Unavailable" window made Rowboat /chat return 500 AFTER the model's
-- calendar_book_appointment tool call had already succeeded. The SMS worker
-- retried the whole turn (correct for the reply) and every retry booked the
-- SAME appointment again — four identical Outlook events for one customer.
--
-- Fix: bookCalendarAppointment (src/lib/calendar-tools/handlers.ts) claims a
-- (business, attendee, start time) slot here BEFORE calling the provider. A
-- repeat claim within the dedupe window returns the recorded event instead of
-- creating another one. Best-effort by design: a ledger failure never blocks
-- a booking (fail-open), so RLS/grant posture matters more than throughput.
--
-- Service-role-only: RLS enabled with NO policies (deny-all for anon /
-- authenticated), the same posture as vps_gateway_tokens — every access goes
-- through the Next.js server after its own auth checks.

create table if not exists calendar_booking_dedupe (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  -- Normalized attendee identity: phone if known, else email, else name.
  attendee_key text not null,
  -- The appointment's start instant (UTC). Same attendee + same start within
  -- the dedupe window = the same booking.
  start_at timestamptz not null,
  -- Provider event id, stamped after a confirmed create. NULL = a claim is
  -- in flight (or the claimant crashed before confirming).
  event_id text,
  created_at timestamptz not null default now()
);

comment on table calendar_booking_dedupe is
  'Idempotency ledger for calendar_book_appointment: one row per (business, attendee, start time). Prevents worker-retried model turns from re-creating the same provider event (2026-07-13 quadruple-booking incident).';

alter table calendar_booking_dedupe enable row level security;

-- One live claim per (business, attendee, start): concurrent duplicate
-- bookings race on this index, and the loser reads the winner's row.
create unique index if not exists uq_calendar_booking_dedupe_slot
  on calendar_booking_dedupe (business_id, attendee_key, start_at);

-- Rows are only useful within the dedupe window; keep the table from growing
-- unbounded by pruning inside the retention sweep's orbit is unnecessary —
-- a tiny table with an index suffices, but expired rows ARE reclaimed lazily:
-- claimBookingDedupe resets any conflicting row older than the window.
