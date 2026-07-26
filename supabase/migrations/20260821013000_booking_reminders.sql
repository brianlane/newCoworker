-- Booking confirmations and reminders for the public booking page.
--
-- A visitor who books gets the provider's bare calendar invitation (or, in
-- platform mode, nothing at all) and then hears nothing until the
-- appointment. These columns back the branded confirmation email and the
-- reminder sweep: the two things that actually reduce no-shows.

alter table public.booking_pages
  -- Branded confirmation email at booking time (needs an attendee email).
  add column if not exists send_confirmation_email boolean not null default true,
  -- Reminder before the appointment: email first, then a text closer in.
  add column if not exists reminders_enabled boolean not null default true,
  -- Hours before the start for the email reminder; 0 disables just that one.
  add column if not exists reminder_email_hours integer not null default 24,
  -- Hours before the start for the SMS reminder; 0 disables just that one.
  add column if not exists reminder_sms_hours integer not null default 2;

alter table public.booking_pages
  add constraint booking_pages_reminder_email_hours_chk
    check (reminder_email_hours between 0 and 168) not valid,
  add constraint booking_pages_reminder_sms_hours_chk
    check (reminder_sms_hours between 0 and 168) not valid;

alter table public.calendar_booking_dedupe
  -- Which reminders have already gone out for this booking, e.g.
  -- {"email": "2026-07-26T16:00:00Z", "sms": "2026-07-27T14:00:00Z"}. The
  -- sweep is idempotent on this: a re-run (or an overlapping tick) must not
  -- text the same person twice.
  add column if not exists reminders_sent jsonb not null default '{}',
  -- Attendee email for the reminder, captured at booking time. The ledger's
  -- attendee_key is phone-first, so an email-reachable booking would
  -- otherwise be unreachable by email.
  add column if not exists attendee_email text,
  -- Attendee display name, for the greeting.
  add column if not exists attendee_name text;

-- The sweep scans upcoming bookings with a reminder still owed.
create index if not exists idx_calendar_booking_dedupe_upcoming_reminders
  on public.calendar_booking_dedupe (start_at)
  where event_id is not null;

-- grants: none (columns and indexes on existing tables that already grant
-- service_role; no new objects are created here).

-- Confirmations and reminders render distinctly on the Emails page.
alter table public.email_log drop constraint if exists email_log_source_check;
alter table public.email_log add constraint email_log_source_check
  check (
    source in (
      'ai_flow',
      'owner_mailbox',
      'email_trigger',
      'dashboard_chat',
      'sms_assistant',
      'voice_assistant',
      'tenant_mailbox_inbound',
      'tenant_mailbox_outbound',
      'owner_manual',
      'email_coworker',
      'booking_reminder'
    )
  );
