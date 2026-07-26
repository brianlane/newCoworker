-- Owner-defined intake questions on the public booking page.
--
-- "What kind of project is this?" asked at booking time is the difference
-- between a prepared call and ten minutes of discovery: the owner defines a
-- few questions (same vocabulary the white-glove questionnaire uses:
-- choice, multi, text, textarea), the visitor answers them in the booking
-- form, and the answers travel with the appointment.

alter table public.booking_pages
  -- Array of question objects; shape validated in
  -- src/lib/booking-page/intake.ts (parseIntakeQuestions). '[]' = none.
  add column if not exists intake_questions jsonb not null default '[]';

alter table public.calendar_booking_dedupe
  -- The visitor's answers, keyed by question id. Null for bookings made
  -- before questions existed, on pages without questions, or by the AI.
  add column if not exists intake_answers jsonb;

-- grants: none (columns on existing tables that already grant service_role).
