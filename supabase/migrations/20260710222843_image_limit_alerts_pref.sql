-- AI image generation: owner-notification toggle for the per-session image
-- limit. When a coworker consumes its 3rd (final) image-generation slot in a
-- session, an activity-log alert is always recorded; this preference
-- (default ON) additionally dispatches an owner notification through the
-- standard notifications path.

alter table public.notification_preferences
  add column if not exists image_limit_alerts boolean not null default true;
