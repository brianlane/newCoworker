-- Owner-facing toggle for warm-transfer SMS notifications.
--
-- Warm-transfer outcome texts (recipient + owner copy) are sent from
-- telnyx-voice-call-end. This per-business preference lets the owner turn that
-- category off from the dashboard Notifications page. Defaults ON so existing
-- behavior is unchanged; the webhook handler fails open (treats a missing row
-- as ON) and only skips when this column is explicitly false.
alter table notification_preferences
  add column if not exists sms_warm_transfer boolean not null default true;
