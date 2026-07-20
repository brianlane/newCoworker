-- Claude connector (MCP) per-user connection status.
--
-- A row is stamped by /api/mcp on the FIRST authenticated request from a
-- user's OAuth bearer — deliberately NOT at consent time, because the known
-- failure mode (WAF blocking Anthropic's verification POST) has OAuth
-- succeed while the connector never works. A row here proves the whole path
-- end to end; the dashboard "Claude connector" card reads it to show
-- Connected + last-used instead of instructions only.
create table if not exists public.mcp_connector_status (
  user_id uuid primary key references auth.users (id) on delete cascade,
  first_connected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table public.mcp_connector_status enable row level security;

comment on table public.mcp_connector_status is
  'First/last authenticated MCP request per auth user (Claude connector). RLS on with no policies — service-role only; written by /api/mcp, read by the dashboard integrations page.';
