-- 'push' becomes a first-class owner-alert delivery channel alongside
-- sms/email/dashboard/whatsapp/slack (same widening pattern as 20260822113305).
--
-- Delivery requires at least one live Web Push subscription for the business
-- (push_subscriptions, 20260828212830); a business that has never subscribed
-- a device records NO push rows at all (the WhatsApp never-connected rule
-- from PR #1148).
--
-- ONE toggle, not two. Push is urgent-only by design and the precedent is
-- WhatsApp, not Slack: a Slack channel is a FEED, where a digest is a message
-- in a scrollback nobody is interrupted by, while a push is an INTERRUPT.
-- whatsapp_urgent shipped alone at 20260811210000 and still has no digest
-- sibling a year later, for the same reason.
--
-- The sharper reason is that a digest push would corrode the very signal this
-- channel exists to produce. A notificationclick is the only true read
-- receipt any alert channel here generates, and channel-liveness reads it. A
-- daily banner nobody taps pushes a healthy tenant past the 10-send floor and
-- makes the best-evidence channel in the system read `silent`. Browsers meter
-- it too: repeatedly ignored notifications degrade the site's permission.
--
-- If a nudge is ever wanted, the right shape is a weekly "you have unread
-- alerts" gated on notifications.read_at IS NULL, which is a different
-- feature with a different column. Do not pre-build push_digest for it.

alter table public.notifications
  drop constraint if exists notifications_delivery_channel_check;
alter table public.notifications
  add constraint notifications_delivery_channel_check
  check (delivery_channel in ('sms', 'email', 'dashboard', 'whatsapp', 'slack', 'push'));

alter table public.notification_preferences
  add column if not exists push_urgent boolean not null default true;

comment on column public.notification_preferences.push_urgent is
  'Deliver urgent owner alerts as a Web Push banner to every device subscribed for this business (owner, teammates). Requires at least one live push_subscriptions row; a business that never subscribed a device records no push rows at all. Urgent only: there is deliberately no push_digest, because a banner is an interrupt and the digest is a document.';

-- grants: none (push_alert_channel): widens a CHECK and adds a column to
-- notifications / notification_preferences, both of which already grant
-- service_role. No new object is created here.
