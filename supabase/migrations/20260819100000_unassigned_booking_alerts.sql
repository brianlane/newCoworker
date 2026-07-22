-- Unassigned-booking owner alerts (Truly, Jul 21 2026): the AI booked a
-- real 12:00 PM broker call for a lead NO ONE owned (route_to_team found no
-- eligible broker after hours; contacts.owner_employee_id stayed null) and
-- no human was ever told the meeting existed — the only owner SMS ("no
-- broker claimed … back to you") predated the booking by three minutes.
--
-- New per-business toggle, ON by default: when the AI confirms a booking
-- for a contact with no owning teammate, the owner gets the standard alert
-- fan-out (dashboard + SMS/email/WhatsApp per channel toggles).
alter table public.notification_preferences
  add column if not exists unassigned_booking_alerts boolean not null default true;
