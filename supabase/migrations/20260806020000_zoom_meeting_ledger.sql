-- Zoom meeting linkage for booked appointments.
--
-- When a business has Zoom connected (first-party `zoom_connections`, or a
-- legacy Nango link), calendar_book_appointment creates a Zoom meeting and
-- threads its join URL into the event + customer confirmation. Reschedules
-- and cancellations must move/delete that SAME meeting, so the booking's
-- ledger row (already the primary event-resolution path for lifecycle
-- operations) records the Zoom meeting id alongside the provider event id.
--
-- NULL for bookings without Zoom. Rows are deleted with their bookings, so
-- the id lives exactly as long as the appointment it belongs to.

alter table calendar_booking_dedupe
  add column if not exists zoom_meeting_id text;

comment on column calendar_booking_dedupe.zoom_meeting_id is
  'Zoom meeting created for this booking (join link sent to the customer); reschedule/cancel move/delete it with the calendar event. NULL when the business had no Zoom connection at booking time.';
