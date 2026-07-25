-- Make the schema self-sufficient: grant service_role explicitly on every
-- pre-convention public object, so a database built FROM THE MIGRATIONS ALONE
-- is usable no matter which Supabase version creates it.
--
-- The gap
-- -------
-- Before 20260820100400_revoke_default_data_api_grants.sql, objects created in
-- `public` received automatic grants to anon/authenticated/service_role, so the
-- ~140 tables, 2 views, 13 sequences, and 111 functions that predate the
-- explicit-grant convention never needed a GRANT of their own. Production still
-- holds those historical grants (audited before writing this file: service_role
-- has all four DML privileges on 140 of 140 public tables and EXECUTE on 111 of
-- 111 public functions, zero exceptions), and the platform's October 30 2026
-- flip only affects NEW objects, so production is unaffected either way.
--
-- A FRESH build is a different story. On a Supabase local stack whose baseline
-- already implements the no-auto-expose default, replaying these migrations
-- produces those same tables with NO service_role DML at all: every privilege
-- the app relies on came from a default ACL that no longer grants it. The
-- symptom is a runtime "permission denied for table ai_flow_runs" (or
-- "permission denied for function claim_ai_flow_runs") from supabase-js EVEN
-- WITH THE SERVICE-ROLE KEY, on a stack whose migrations all applied cleanly.
-- That cost a debugging session on the Worker Integration suite (Jul 25 2026)
-- and made the CI Supabase-CLI pin load-bearing for something a pin should not
-- have to carry.
--
-- This migration closes it by stating the grants the schema actually depends
-- on. It is a ONE-TIME BACKFILL for everything created up to this point, not a
-- blanket escape hatch: from 20260820100400 onward every migration must still
-- grant its own new objects explicitly, and tests/migration-grants.test.ts
-- keeps failing PRs that forget (see .cursor/rules/migration-grants.mdc).
--
-- Scope: service_role ONLY
-- ------------------------
-- Deliberately no anon/authenticated grants here, even though production still
-- carries legacy ones on the 61 policy-bearing tables. Re-granting broad table
-- privileges to browser-facing roles is exactly what
-- 20260820100500_revoke_legacy_deny_all_table_grants.sql removed as a latent
-- hazard, and every data path in this platform is service-role (the Next server
-- and the Edge functions). The genuinely client-readable surface keeps its own
-- explicit grants in its own migrations (e.g. the column-level
-- `update (read_at) on notifications to authenticated`). One known residue:
-- base SELECT for `authenticated` on notifications / ai_flow_library still
-- rides the legacy auto-grant in production, so a fresh build lacks it. That is
-- left alone on purpose, because widening a browser-facing role is a security
-- decision that belongs in its own change, not a side effect of a backfill.
--
-- Idempotent (re-granting a held privilege is a no-op) and behavior-neutral in
-- production by construction: every GRANT below is one production already has.

do $$
declare
  r record;
  granted int := 0;
begin
  -- Tables, partitioned tables, and views. `grant ... on all tables in schema`
  -- would cover these in one statement, but the loop lets us skip
  -- extension-owned relations (zero today, cheap insurance if an extension is
  -- ever installed into public) and report a count the way the sibling
  -- deny-all sweep does.
  for r in
    select c.oid::regclass as rel
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public'
      and c.relkind in ('r', 'p', 'v')
      and not exists (
        select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e'
      )
  loop
    execute format('grant select, insert, update, delete on %s to service_role', r.rel);
    granted := granted + 1;
  end loop;
  raise notice 'service_role grant backfill: % table(s)/view(s)', granted;

  granted := 0;
  -- Sequences: serial columns need USAGE to nextval. (New objects should
  -- prefer identity columns, which need no sequence grant at all.)
  for r in
    select c.oid::regclass as rel
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public'
      and c.relkind = 'S'
      and not exists (
        select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e'
      )
  loop
    execute format('grant usage, select on sequence %s to service_role', r.rel);
    granted := granted + 1;
  end loop;
  raise notice 'service_role grant backfill: % sequence(s)', granted;

  granted := 0;
  -- Callable functions: every `.rpc()` surface. Trigger and event-trigger
  -- functions are EXCLUDED: they run as owner and are never invoked through
  -- PostgREST, so they need no grant (the convention in
  -- .cursor/rules/migration-grants.mdc). Production happens to carry EXECUTE on
  -- them from the old auto-grant; not reproducing that is the tidier end state,
  -- and it changes nothing callable. This never fights the fn_grants_lockdown
  -- event trigger: that trigger fires on CREATE/ALTER FUNCTION and only revokes
  -- public/anon/authenticated, never service_role.
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
      and not exists (
        select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'
      )
  loop
    execute format('grant execute on function %s to service_role', r.fn);
    granted := granted + 1;
  end loop;
  raise notice 'service_role grant backfill: % function(s)', granted;
end$$;
