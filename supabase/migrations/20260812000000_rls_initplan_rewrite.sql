-- RLS initplan rewrite (Supabase performance advisor `auth_rls_initplan`,
-- 92 findings) + permissive-policy consolidation (`multiple_permissive_policies`,
-- 42 findings).
--
-- Two classes of policy are touched, both mechanically and both
-- behavior-preserving:
--
-- 1. Owner policies whose expressions call `auth.email()` / `auth.jwt()`
--    directly. Postgres re-evaluates a bare `auth.*()` call FOR EVERY ROW
--    the query scans; wrapping it as `( SELECT auth.email() )` makes the
--    planner evaluate it once per statement (an InitPlan) and treat it as a
--    constant. Same rows pass, same rows fail — only the evaluation count
--    changes. This is the official Supabase remediation for advisor 0003.
--
-- 2. "Service role manages <table>" policies declared `TO public` with
--    `USING (auth.role() = 'service_role')`. These are documentation-grade:
--    service_role BYPASSES RLS entirely (BYPASSRLS), so the qual never
--    admits anyone — anon/authenticated evaluate it per row and always get
--    false. Re-declaring them `TO service_role USING (true)` is exactly
--    equivalent (deny for anon/authenticated, no-op for service_role) but
--    (a) removes the per-row evaluation for every client query, and
--    (b) stops the policy from COUNTING as an applicable permissive policy
--    for anon/authenticated — which is what closes all 42
--    `multiple_permissive_policies` findings (tables like daily_usage had
--    both an owner-read policy and a service policy applying to the same
--    role+action).
--
-- Implemented as a catalog-driven loop rather than 92 hardcoded ALTER
-- POLICY statements so it is:
--   - exact: expressions are read from pg_policies and rewritten in place,
--     never re-typed by hand;
--   - idempotent: already-wrapped expressions (containing `SELECT auth.`)
--     are masked before the rewrite, so a re-run (or a shadow-db replay
--     where some policies already carry the wrapped form) is a no-op;
--   - complete: any policy this migration's ancestors created with a bare
--     auth call is caught, not just the ones enumerated by today's advisor.
do $$
declare
  p record;
  fixed_qual text;
  fixed_check text;
  svc_expr constant text := '(auth.role() = ''service_role''::text)';
  narrowed int := 0;
  rewritten int := 0;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      -- Mask wrapped calls (`( SELECT auth.x() ...)`) first; anything that
      -- still matches afterwards is a bare, per-row call that needs fixing.
      and replace(coalesce(qual, '') || ' ' || coalesce(with_check, ''), 'SELECT auth.', '')
          ~ 'auth\.(uid|jwt|role|email)\(\)'
  loop
    -- Class 2: service-role-only policies -> narrow the role, drop the qual.
    if (p.qual is not distinct from svc_expr and p.with_check is null) then
      execute format(
        'alter policy %I on %I.%I to service_role using (true)',
        p.policyname, p.schemaname, p.tablename
      );
      narrowed := narrowed + 1;
      continue;
    end if;
    if (p.with_check is not distinct from svc_expr and p.qual is null) then
      execute format(
        'alter policy %I on %I.%I to service_role with check (true)',
        p.policyname, p.schemaname, p.tablename
      );
      narrowed := narrowed + 1;
      continue;
    end if;

    -- Class 1: wrap every bare auth.*() call in a scalar subselect.
    -- Sentinel-mask already-wrapped occurrences so they are never
    -- double-wrapped, rewrite the bare ones, then unmask.
    fixed_qual := case when p.qual is null then null else
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(p.qual, 'SELECT auth.', '@@WRAPPED_AUTH@@'),
                'auth.uid()', '( SELECT auth.uid() )'),
              'auth.role()', '( SELECT auth.role() )'),
            'auth.email()', '( SELECT auth.email() )'),
          'auth.jwt()', '( SELECT auth.jwt() )'),
        '@@WRAPPED_AUTH@@', 'SELECT auth.')
    end;
    fixed_check := case when p.with_check is null then null else
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(p.with_check, 'SELECT auth.', '@@WRAPPED_AUTH@@'),
                'auth.uid()', '( SELECT auth.uid() )'),
              'auth.role()', '( SELECT auth.role() )'),
            'auth.email()', '( SELECT auth.email() )'),
          'auth.jwt()', '( SELECT auth.jwt() )'),
        '@@WRAPPED_AUTH@@', 'SELECT auth.')
    end;

    if fixed_qual is distinct from p.qual or fixed_check is distinct from p.with_check then
      execute format(
        'alter policy %I on %I.%I%s%s',
        p.policyname, p.schemaname, p.tablename,
        case when fixed_qual is not null then format(' using (%s)', fixed_qual) else '' end,
        case when fixed_check is not null then format(' with check (%s)', fixed_check) else '' end
      );
      rewritten := rewritten + 1;
    end if;
  end loop;

  raise notice 'rls_initplan_rewrite: % policies narrowed to service_role, % expressions wrapped', narrowed, rewritten;
end $$;
