-- ---------------------------------------------------------------------------
-- Weekly blog rotation: per-category toggles for the Monday auto-post cron.
--
-- The cron now rotates on a 4-week cycle — PR digest (platform-updates),
-- Tutorial, Business Tips, Feature deep-dive — one post per week. Each
-- rotating category gets its own enable toggle; a disabled (or ungrounded,
-- or too-thin) category week falls back to the PR digest, so
-- `digest_enabled` remains the master off-switch.
-- ---------------------------------------------------------------------------

alter table public.blog_settings
  add column if not exists auto_tutorial_enabled boolean not null default true,
  add column if not exists auto_business_tips_enabled boolean not null default true,
  add column if not exists auto_feature_enabled boolean not null default true;

comment on table public.blog_settings is
  'Single-row operator toggles for the platform blog: the weekly auto-post rotation (PR digest / tutorial / business tips / feature deep-dive), draft/image behavior for auto posts, and the Instagram cross-post target/mode.';
