-- Per-business admin notification mutes.
--
-- Three independent switches, flipped from the admin business page, that
-- exclude one business from the fleet-wide feeds on /admin/dashboard:
--   * admin_mute_activity — "Recent Activity" (coworker_logs, all rows)
--   * admin_mute_errors   — "System Errors: All Clients" (system_logs level=error)
--   * admin_mute_alerts   — "Recent Alerts" (coworker_logs urgent_alert/error)
--
-- Muting only hides the business from the aggregate admin feeds; the rows
-- are still written and stay fully visible on that business's own admin
-- page, and owner-facing notifications are untouched.
alter table businesses
  add column if not exists admin_mute_activity boolean not null default false,
  add column if not exists admin_mute_errors boolean not null default false,
  add column if not exists admin_mute_alerts boolean not null default false;

comment on column businesses.admin_mute_activity is
  'When true, this business is hidden from the admin dashboard Recent Activity feed.';
comment on column businesses.admin_mute_errors is
  'When true, this business is hidden from the admin dashboard System Errors feed.';
comment on column businesses.admin_mute_alerts is
  'When true, this business is hidden from the admin dashboard Recent Alerts feed.';
