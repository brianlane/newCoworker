-- Early opt-in to Supabase's Data API default flip (changelog 45329,
-- "Breaking Change: Tables not exposed to Data and GraphQL API automatically").
--
-- Background
-- ----------
-- On October 30, 2026 Supabase applies the new default to all existing
-- projects: tables, functions, and sequences created in `public` stop
-- receiving the automatic grants to `anon`, `authenticated`, and
-- `service_role`. Existing objects keep their grants. Every data path in
-- this platform IS the Data API (service-role supabase-js in the Next app
-- and the Edge functions; there is no direct Postgres connection), so a
-- migration that creates a table without an explicit GRANT would apply
-- cleanly via `supabase db push` and then fail at runtime with
-- "permission denied" the first time the app touches the table.
--
-- Rather than wait for the platform flip to surprise us in late October,
-- this migration applies the same default-privilege revokes now (the
-- documented script from the Supabase "Securing your API" guide). From this
-- migration on, every new table, view, function, or sequence must carry its
-- own explicit grants in the same migration file. tests/migration-grants.test.ts
-- enforces that, and the local CI stack (`supabase start` in the Worker
-- Integration job) behaves identically to production, so a forgotten grant
-- fails the PR, never production.
--
-- Notes
-- -----
--   * Existing objects are untouched: default privileges only affect objects
--     created AFTER this migration runs.
--   * `alter default privileges` without FOR ROLE targets the current role
--     (postgres, the migration runner). The FOR ROLE postgres variants make
--     the intent explicit and also cover a hypothetical runner that is a
--     different superuser. The `supabase_admin` default ACL cannot be
--     altered from here (the migration role is not a member), but no
--     migration-created object is created by supabase_admin, and the
--     platform flip retires that ACL on October 30 anyway.
--   * Functions already had anon/authenticated revoked at the default-ACL
--     level (20260618182009) and are force-revoked by the fn_grants_lockdown
--     event trigger. The new part here is revoking the automatic
--     service_role EXECUTE, so new RPC functions need an explicit
--     `grant execute ... to service_role` too.
--   * Version stamp: the production ledger head is already at
--     20260820100300 (future-stamped KG migrations), and `supabase db push`
--     refuses local files stamped before the remote head, so this file is
--     stamped just past it (the PR #775 re-stamp precedent) rather than at
--     the real creation datetime (2026-07-23).

alter default privileges in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges in schema public
  revoke execute on functions from anon, authenticated, service_role;
alter default privileges in schema public
  revoke execute on functions from public;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from public;
