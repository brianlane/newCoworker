-- Per-business Slack workspace connections (first-party OAuth v2).
--
-- The owner installs our Slack app into their workspace through
-- /api/integrations/slack/connect; the callback stores the bot token here.
-- Slack bot tokens (xoxb) do not expire and are not refreshed: one token per
-- workspace install, revoked only by uninstall (app_uninstalled /
-- tokens_revoked webhooks wipe the pair like Zoom's app_deauthorized).
--
-- One workspace maps to one business in BOTH directions:
--   - business_id unique: a business connects a single Slack workspace;
--   - team_id unique: a workspace cannot be claimed by two businesses, since
--     inbound events carry only team_id and must resolve to one tenant.
--
-- alert_channel_id/_name: the channel the owner picked for coworker alerts
-- (and later the digest + approval prompts). Set via PATCH after a
-- successful hello post proves the bot can actually deliver there.
--
-- Security posture matches zoom_connections / acuity_connections: RLS on
-- with NO policies (service-role only), bot token AES-256-GCM encrypted at
-- rest via encryptIntegrationSecret (src/lib/integrations/secrets.ts).

create table if not exists public.slack_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Slack workspace (team) identity from oauth.v2.access.
  team_id text not null,
  team_name text,
  -- Set when the workspace belongs to an Enterprise Grid org.
  enterprise_id text,
  -- The app's bot user in this workspace ("@New Coworker").
  bot_user_id text not null,
  app_id text not null,
  -- AES-256-GCM envelope (`enc:v1:<iv>:<tag>:<ct>`); empty string after an
  -- uninstall wipe (the row survives so the card shows "Needs reconnect").
  bot_token_encrypted text not null,
  -- Comma-separated bot scopes granted at install, as reported by Slack.
  scopes text not null default '',
  alert_channel_id text,
  alert_channel_name text,
  -- Soft-disable: owner pause, or automatically false on uninstall/revoke.
  is_active boolean not null default true,
  -- Dashboard user who ran the install (audit; no FK, auth users live in
  -- the auth schema).
  installed_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One Slack workspace per business (upsert target).
create unique index if not exists uq_slack_connections_business
  on public.slack_connections (business_id);

-- One business per Slack workspace (webhook events resolve by team_id).
create unique index if not exists uq_slack_connections_team
  on public.slack_connections (team_id);

alter table public.slack_connections enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").
grant select, insert, update, delete on table public.slack_connections to service_role;
