-- Per-user dashboard sidebar customization (order + visibility), modeled on
-- BizBlasts' UserSidebarItem. Keyed by the auth user id so each login keeps
-- its own layout across the businesses it can access. Item keys are the
-- stable identifiers in src/lib/dashboard/sidebar-items.ts; merge logic
-- (append newly shipped nav items missing from a saved layout) lives in
-- src/lib/dashboard/sidebar-prefs.ts.
--
-- RLS on with NO policies = service-role only, matching platform posture:
-- reads/writes go through the Next.js server after its own auth checks.

create table if not exists public.user_sidebar_items (
  user_id uuid not null,
  item_key text not null,
  position integer not null default 0,
  visible boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, item_key)
);

alter table public.user_sidebar_items enable row level security;
