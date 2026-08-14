-- Connector status becomes per (user, client, business), not per (user, client).
--
-- The dashboard's Claude / ChatGPT tiles sit on /dashboard/integrations next to
-- twelve business-scoped tiles, but they were the only two reading a row keyed
-- on the signed-in login alone. Under admin view-as the session user stays the
-- admin while the page renders a tenant, so the admin's own rows were painted
-- onto every tenant's tiles: three of nine live businesses read "Connected"
-- while their owners had never connected anything. The same key also hid a real
-- connection from every teammate except the one who made it.
--
-- Attribution now comes from where a business is genuinely known: the tool-call
-- authorization path (mcpBusinessRoleOutcome in src/lib/mcp/auth.ts), not the
-- bearer check, which resolves only (userId, email).
--
-- Backfill: every existing row belongs to a login that can reach exactly one
-- business, so it is attributable without guessing. Rows whose login can reach
-- none, or more than one, cannot be attributed and are deleted rather than
-- assigned: the next tool call re-stamps them with the real business, and a
-- wrong id here would recreate the bug this migration exists to fix. Zero live
-- rows fall in that bucket today.
--
-- No Data API grants needed: this alters an existing table rather than creating
-- one, and the table stays service-role only (RLS on, no policies).
-- grants: none (mcp_connector_status): pre-existing table, unchanged access

alter table public.mcp_connector_status
  add column if not exists business_id uuid references public.businesses (id) on delete cascade;

with accessible as (
  select s.user_id, b.id as business_id
  from public.mcp_connector_status s
  join auth.users u on u.id = s.user_id
  join public.businesses b on lower(b.owner_email) = lower(u.email)
  union
  select s.user_id, m.business_id
  from public.mcp_connector_status s
  join auth.users u on u.id = s.user_id
  join public.business_members m
    on lower(m.email) = lower(u.email)
   and m.status <> 'revoked'
),
sole as (
  -- array_agg, not min: uuid has no min() in Postgres, and the having clause
  -- means there is exactly one element to take anyway.
  select user_id, (array_agg(business_id))[1] as business_id
  from accessible
  group by user_id
  having count(*) = 1
)
update public.mcp_connector_status s
set business_id = sole.business_id
from sole
where sole.user_id = s.user_id
  and s.business_id is null;

delete from public.mcp_connector_status where business_id is null;

alter table public.mcp_connector_status
  alter column business_id set not null;

-- The primary key widens with it: one row per user per client per business.
alter table public.mcp_connector_status
  drop constraint if exists mcp_connector_status_pkey;

alter table public.mcp_connector_status
  add constraint mcp_connector_status_pkey primary key (user_id, client, business_id);

-- The dashboard read filters on exactly this pair (every login for one
-- business and one client), which the user-leading primary key cannot serve.
create index if not exists mcp_connector_status_business_client_idx
  on public.mcp_connector_status (business_id, client);

comment on column public.mcp_connector_status.business_id is
  'Which business the assistant acted on. Stamped by the MCP tool-call authorization path, so a row means an authorized call actually touched this business, not merely that its owner completed OAuth.';

comment on table public.mcp_connector_status is
  'First/last authorized MCP tool call per (auth user, MCP client, business). RLS on with no policies, service-role only; written by src/lib/mcp/auth.ts, read by the dashboard integrations page, cleared by the Disconnect button on the connector card.';
