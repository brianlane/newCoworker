-- Legacy grant cleanup: revoke anon/authenticated on deny-all tables.
--
-- Companion to 20260820100400_revoke_default_data_api_grants.sql. Before
-- that migration, every table created in `public` received automatic
-- SELECT/INSERT/UPDATE/DELETE grants for `anon` and `authenticated`. On the
-- service-role-only tables (RLS enabled with deliberately ZERO policies,
-- the deny-all posture documented in the README security section), those
-- grants were dead weight: RLS already returns nothing for those roles.
-- But they kept a latent hazard alive: each table sat one accidental
-- `alter table ... disable row level security` away from exposing tenant
-- data through the anon PostgREST path.
--
-- This sweep revokes anon/authenticated table grants from exactly the
-- deny-all set, identified mechanically: RLS enabled AND zero policies.
-- Tables with any RLS policy (the deliberately client-readable set, e.g.
-- notifications, the dashboard-chat tables, ai_flow_library) are untouched,
-- and service_role grants are never touched anywhere. Behavior-neutral by
-- construction; each revoked table is logged with a NOTICE so the applied
-- list is visible in the migration log. The same predicate runs identically
-- on the local CI stack and in production.

do $$
declare
  r record;
  swept int := 0;
begin
  for r in
    select c.oid::regclass as tbl
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public'
      and c.relkind in ('r', 'p')          -- ordinary + partitioned tables
      and c.relrowsecurity                 -- RLS enabled...
      and not exists (                     -- ...with zero policies (deny-all)
        select 1 from pg_policy p where p.polrelid = c.oid
      )
      and not exists (                     -- leave extension-owned tables alone
        select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e'
      )
  loop
    execute format('revoke all on table %s from anon, authenticated', r.tbl);
    swept := swept + 1;
    raise notice 'deny-all grant sweep: revoked anon/authenticated on %', r.tbl;
  end loop;
  raise notice 'deny-all grant sweep: % table(s) swept', swept;
end$$;
