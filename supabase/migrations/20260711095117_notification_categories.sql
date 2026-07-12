-- Per-category notification preferences (BizBlasts-style event categories).
--
-- The existing toggles are per-CHANNEL (sms_urgent / email_urgent / ...);
-- these are per-CATEGORY filters applied on top: an alert is delivered only
-- when its channel toggle AND its category toggle are both on. Kind →
-- category mapping lives in src/lib/notifications/categories.ts:
--   leads  — new-lead captures (voice_capture)
--   team   — team-notify pings (voice_team_notify, sms_team_notify)
--   system — platform/system events (byon_port, ...)
-- Generic urgent alerts ("general") are never category-gated.

alter table public.notification_preferences
  add column if not exists category_leads boolean not null default true,
  add column if not exists category_team boolean not null default true,
  add column if not exists category_system boolean not null default true;
