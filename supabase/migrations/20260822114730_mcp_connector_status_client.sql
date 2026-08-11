-- Connector status becomes per (user, client), not per user.
--
-- The table was written when Claude was the only MCP client we had. A second
-- one is coming (ChatGPT), and the dashboard shows a "Connected, last used X"
-- badge per connector, so a single row per user would light both cards the
-- moment either client made a request.
--
-- Additive with a default, so this is safe to apply before the code that
-- writes the new column: every existing row IS a Claude connection, the
-- default backfills them in this same statement, and the old code path
-- (select ... eq user_id ... maybeSingle) keeps working until a user actually
-- has two rows, which cannot happen before the second route exists.
--
-- No Data API grants needed: this alters an existing table rather than
-- creating one, and the table stays service-role only (RLS on, no policies).
-- grants: none (mcp_connector_status): pre-existing table, unchanged access

alter table public.mcp_connector_status
  add column if not exists client text not null default 'claude';

-- The primary key has to widen with it: one row per user per client.
alter table public.mcp_connector_status
  drop constraint if exists mcp_connector_status_pkey;

alter table public.mcp_connector_status
  add constraint mcp_connector_status_pkey primary key (user_id, client);

comment on column public.mcp_connector_status.client is
  'Which MCP client connected: claude | chatgpt. Source of truth for the allowed values is MCP_CLIENTS in src/lib/mcp/routes.ts, deliberately not a check constraint so adding a client is a code change rather than a migration.';

comment on table public.mcp_connector_status is
  'First/last authenticated MCP request per (auth user, MCP client). RLS on with no policies — service-role only; written by the MCP routes, read by the dashboard integrations page.';
