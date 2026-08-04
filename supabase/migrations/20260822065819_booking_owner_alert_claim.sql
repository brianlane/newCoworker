-- Has the owner been told about this booking yet?
--
-- The owner alert reports WHO is on the hook for an appointment, so it runs
-- after the contact is filed and the assignee is stamped. That ordering is
-- the point, and it widens the window between "the appointment is durable"
-- and "a human knows it exists": a first request that persists the booking
-- and then dies leaves an appointment nobody was told about, and the
-- visitor's idempotent resubmit returns success without paging anyone.
--
-- So the alert is CLAIMED on the booking row before it goes out, the same
-- conditional-update shape `assignee_member_id` and `reminders_sent` already
-- use: the first caller to win the claim sends, and every later one sees it
-- taken. A resubmit can therefore close the gap without ever being able to
-- alert twice for one booking.
--
-- Null means "not told yet", which is also the right reading for rows that
-- predate this column: the alert only ever fires from the submit path of a
-- booking being made now, so an old row is never revisited.

alter table public.calendar_booking_dedupe
  add column if not exists owner_alerted_at timestamptz;

-- grants: none (no object is created here; this adds a column to
-- calendar_booking_dedupe, which already grants service_role).
