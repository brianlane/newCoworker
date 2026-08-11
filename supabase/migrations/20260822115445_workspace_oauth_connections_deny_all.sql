-- Move workspace_oauth_connections to the deny-all posture (service_role only).
--
-- WHY NOW: this table is about to hold OAuth token ciphertext. The Outlook
-- integration is moving off Nango onto our own Microsoft OAuth, and the
-- transport choice lives in a column on this table, so the next migration
-- adds access_token_encrypted / refresh_token_encrypted. Ciphertext must not
-- land while anon/authenticated can still reach the table.
--
-- WHAT IS WRONG TODAY: the table was created 2026-04-12, BEFORE
-- 20260820100400_revoke_default_data_api_grants.sql, so it still carries the
-- automatic anon/authenticated table grants every public table used to get.
-- The follow-up sweep 20260820100500_revoke_legacy_deny_all_table_grants.sql
-- revoked those grants across the credential tables, but it selected only
-- tables with ZERO policies, and this one has four owner policies, so it was
-- skipped. The result is a table reachable through the owner's own PostgREST
-- session. Harmless while the rows are just Nango pointers (a connection_id
-- and a provider key); not harmless one migration from now.
--
-- WHY DROPPING THE POLICIES IS SAFE: nothing reads this table with an anon or
-- authenticated client. Audited at the time of writing, every caller goes
-- through a service-role client:
--   - src/lib/db/workspace-oauth-connections.ts (all six queries)
--     and src/lib/nango/cleanup.ts, both via createSupabaseServiceClient;
--   - scripts/oneshot/setup-hq-inbox-triage-flow.ts, same;
--   - debug/nango-audit.ts, debug/backfill-nango-account-identity.ts,
--     debug/cancel-ghost-booking.ts, scripts/oneshot/set-kyp-booking-email-sender.ts,
--     all createClient() with SUPABASE_SERVICE_ROLE_KEY.
-- No client component queries the table: the dashboard receives connections
-- already serialized by the server (src/lib/dashboard/integrations-context.ts).
--
-- This is the same posture as every other tenant-credential table here
-- (zoom_connections, slack_connections, meta_connections, calendly_connections,
-- vagaro_connections, caldav_connections): RLS on, zero policies, explicit
-- service_role grant. See README "RLS enabled, no policies".

drop policy if exists "Owner reads workspace_oauth_connections"
  on public.workspace_oauth_connections;
drop policy if exists "Owner inserts workspace_oauth_connections"
  on public.workspace_oauth_connections;
drop policy if exists "Owner updates workspace_oauth_connections"
  on public.workspace_oauth_connections;
drop policy if exists "Owner deletes workspace_oauth_connections"
  on public.workspace_oauth_connections;

-- RLS is already enabled (20260412180000); assert it rather than assume, since
-- with the policies gone this is the only thing standing between a legacy
-- grant and the table.
alter table public.workspace_oauth_connections enable row level security;

revoke all on table public.workspace_oauth_connections from anon, authenticated;
grant select, insert, update, delete
  on table public.workspace_oauth_connections to service_role;
