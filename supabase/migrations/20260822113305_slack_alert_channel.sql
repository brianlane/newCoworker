-- 'slack' becomes a first-class owner-alert delivery channel alongside
-- sms/email/dashboard/whatsapp (same widening pattern as 20260811210000).
--
-- Delivery requires a connected Slack workspace (slack_connections, PR
-- #1265) with an alert channel picked; a business that never connected
-- Slack records NO slack rows at all (the WhatsApp never-connected rule
-- from PR #1148). Two preference toggles, both default ON with the same
-- fail-toward-delivering posture as the other channels:
--   slack_urgent  urgent owner alerts posted to the picked channel
--   slack_digest  the daily/weekly digest posted to the same channel

alter table public.notifications
  drop constraint if exists notifications_delivery_channel_check;
alter table public.notifications
  add constraint notifications_delivery_channel_check
  check (delivery_channel in ('sms', 'email', 'dashboard', 'whatsapp', 'slack'));

alter table public.notification_preferences
  add column if not exists slack_urgent boolean not null default true;
alter table public.notification_preferences
  add column if not exists slack_digest boolean not null default true;

comment on column public.notification_preferences.slack_urgent is
  'Deliver urgent owner alerts to the picked Slack channel (requires a connected Slack workspace with an alert channel set).';
comment on column public.notification_preferences.slack_digest is
  'Post the daily/weekly digest to the picked Slack channel (requires a connected Slack workspace with an alert channel set).';
