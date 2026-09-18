-- Honest reconnect state for every stored grant that can permanently fail
-- auth. Calendly already has these columns (20260918063020); this migration
-- lifts the same four onto the other connection tables that have a real
-- token-refresh or API-auth failure path.
--
-- needs_reauth is DISTINCT from the owner's Disable/Pause toggle: the row
-- stays so Reconnect can write a new grant onto the SAME connection, while
-- pollers, token managers, and resolvers skip it. last_healthy_at is the
-- last tick that successfully talked to the provider. reauth_email_count /
-- reauth_email_last_sent_at are the product-email cadence: once on the
-- flip, once more after a day if it is still broken, then stop.

alter table public.workspace_oauth_connections
  add column if not exists needs_reauth boolean not null default false,
  add column if not exists last_healthy_at timestamptz,
  add column if not exists reauth_email_count integer not null default 0,
  add column if not exists reauth_email_last_sent_at timestamptz;

create index if not exists idx_workspace_oauth_connections_needs_reauth
  on public.workspace_oauth_connections (business_id)
  where needs_reauth = true;

alter table public.zoom_connections
  add column if not exists needs_reauth boolean not null default false,
  add column if not exists last_healthy_at timestamptz,
  add column if not exists reauth_email_count integer not null default 0,
  add column if not exists reauth_email_last_sent_at timestamptz;

create index if not exists idx_zoom_connections_needs_reauth
  on public.zoom_connections (business_id)
  where needs_reauth = true;

alter table public.acuity_connections
  add column if not exists needs_reauth boolean not null default false,
  add column if not exists last_healthy_at timestamptz,
  add column if not exists reauth_email_count integer not null default 0,
  add column if not exists reauth_email_last_sent_at timestamptz;

create index if not exists idx_acuity_connections_needs_reauth
  on public.acuity_connections (business_id)
  where needs_reauth = true;

alter table public.caldav_connections
  add column if not exists needs_reauth boolean not null default false,
  add column if not exists last_healthy_at timestamptz,
  add column if not exists reauth_email_count integer not null default 0,
  add column if not exists reauth_email_last_sent_at timestamptz;

create index if not exists idx_caldav_connections_needs_reauth
  on public.caldav_connections (business_id)
  where needs_reauth = true;

alter table public.vagaro_connections
  add column if not exists needs_reauth boolean not null default false,
  add column if not exists last_healthy_at timestamptz,
  add column if not exists reauth_email_count integer not null default 0,
  add column if not exists reauth_email_last_sent_at timestamptz;

create index if not exists idx_vagaro_connections_needs_reauth
  on public.vagaro_connections (business_id)
  where needs_reauth = true;

alter table public.meta_connections
  add column if not exists needs_reauth boolean not null default false,
  add column if not exists last_healthy_at timestamptz,
  add column if not exists reauth_email_count integer not null default 0,
  add column if not exists reauth_email_last_sent_at timestamptz;

create index if not exists idx_meta_connections_needs_reauth
  on public.meta_connections (business_id)
  where needs_reauth = true;

alter table public.slack_connections
  add column if not exists needs_reauth boolean not null default false,
  add column if not exists last_healthy_at timestamptz,
  add column if not exists reauth_email_count integer not null default 0,
  add column if not exists reauth_email_last_sent_at timestamptz;

create index if not exists idx_slack_connections_needs_reauth
  on public.slack_connections (business_id)
  where needs_reauth = true;

alter table public.whatsapp_connections
  add column if not exists needs_reauth boolean not null default false,
  add column if not exists last_healthy_at timestamptz,
  add column if not exists reauth_email_count integer not null default 0,
  add column if not exists reauth_email_last_sent_at timestamptz;

create index if not exists idx_whatsapp_connections_needs_reauth
  on public.whatsapp_connections (business_id)
  where needs_reauth = true;

-- grants: none (column/index changes on existing service-role-only tables;
-- no new Data API objects).
