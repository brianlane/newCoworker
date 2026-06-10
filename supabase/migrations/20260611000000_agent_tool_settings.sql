-- ---------------------------------------------------------------------------
-- agent_tool_settings — per-tenant overrides for which tools each coworker
-- surface (dashboard chat, voice, SMS) is allowed to use.
--
-- The catalog of workers/tools and their DEFAULT enabled state lives in code
-- (src/lib/agent-tools/registry.ts) so adding a tool never requires a
-- migration. This table stores only the owner's explicit overrides; a missing
-- row means "use the registry default". Reads/writes go through the service
-- role (the /api/dashboard/agent-tools route gates on requireOwner, the VPS
-- chat-worker and the /api/voice/tools/* adapters hold the service role /
-- gateway token), so access is service-role-only — same trust model as
-- system_logs and dashboard_chat_jobs.
-- ---------------------------------------------------------------------------

create table if not exists agent_tool_settings (
  business_id uuid not null references businesses(id) on delete cascade,
  -- Worker surface key from the code registry: 'dashboard' | 'voice' | 'sms'.
  -- Free text by design (new surfaces must not require a migration); the API
  -- route validates against the registry before writing.
  agent_key text not null,
  tool_key text not null,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (business_id, agent_key, tool_key)
);

alter table agent_tool_settings enable row level security;

drop policy if exists "Service role manages agent_tool_settings" on agent_tool_settings;
create policy "Service role manages agent_tool_settings"
  on agent_tool_settings for all
  using (auth.role() = 'service_role');
