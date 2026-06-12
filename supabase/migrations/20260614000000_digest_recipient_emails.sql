-- Per-window digest recipients: owners can send the daily digest to one
-- address (e.g. themselves) and the weekly digest to another (e.g. a
-- partner or assistant). Null = fall back to the existing chain
-- (alert_email -> owner_email -> ADMIN_EMAIL), so behavior is unchanged
-- until an owner sets a value.

alter table notification_preferences
  add column if not exists digest_email_daily text,
  add column if not exists digest_email_weekly text;

comment on column notification_preferences.digest_email_daily is
  'Optional recipient override for the daily digest. Null = alert_email -> owner_email fallback.';
comment on column notification_preferences.digest_email_weekly is
  'Optional recipient override for the weekly digest. Null = alert_email -> owner_email fallback.';
