-- Which Zoom Marketplace OAuth client minted this connection's token pair.
--
-- "New Coworker OAuth" has two credential pairs, the published production
-- client and the development client. A Marketplace UPDATE (new scope or a new
-- event subscription) only exists on the development client until Zoom
-- approves it, so the reviewer has to authorize the sandbox tenant against
-- the DEVELOPMENT client id to exercise what is actually under review. Which
-- client minted a grant then matters for the rest of that connection's life:
-- the refresh and the revoke must present the SAME client id and secret, or
-- Zoom answers invalid_client and the connection silently strands.
--
-- Selection is per business at connect time (ZOOM_DEV_OAUTH_BUSINESS_IDS),
-- and the choice is carried through the signed OAuth state so a mid-flow env
-- change cannot make the callback exchange against the wrong client. Existing
-- rows were all minted by the production client, hence the default.

alter table public.zoom_connections
  add column if not exists oauth_client_env text not null default 'production';

alter table public.zoom_connections
  drop constraint if exists zoom_connections_oauth_client_env_check;

alter table public.zoom_connections
  add constraint zoom_connections_oauth_client_env_check
  check (oauth_client_env in ('production', 'development'));

comment on column public.zoom_connections.oauth_client_env is
  'Which Zoom OAuth client minted this token pair: production (ZOOM_CLIENT_ID) or development (ZOOM_DEV_CLIENT_ID). Refresh and revoke must present the matching credentials.';

-- Webhook routing resolves the tenant from the delivery's Zoom user id, and
-- now must scope that to the app that actually sent the delivery: a dev-app
-- app_deauthorized must never wipe a production tenant sharing the same Zoom
-- account. Both routing queries filter on the pair, which until now had no
-- index at all (the table only indexes business_id).
create index if not exists idx_zoom_connections_zoom_user_env
  on public.zoom_connections (zoom_user_id, oauth_client_env)
  where zoom_user_id is not null;

-- grants: none (idx_zoom_connections_zoom_user_env): index, not a Data API
-- object. The table's existing service_role grants cover the new column.
