-- Bounded run-evidence reader for the cron sweep watchdog.
--
-- The watchdog's first Sunday email reported seven healthy daily sweeps as
-- STOPPED. The route read its 8-day window with a plain windowed select, and
-- PostgREST caps an un-limited select at 1,000 rows. The fleet writes ~8,800
-- cron-sourced rows per day, so the newest-first result silently truncated
-- to roughly the last three hours, and every daily sweep whose last run was
-- older than that vanished from the read. Verified against production on
-- 2026-08-10: 8,834 rows in the lookback, the 1,000th newest row was 14
-- minutes old, and all seven "stopped" sweeps had recorded their runs on
-- schedule.
--
-- The fix is to aggregate server-side. The watchdog needs exactly two
-- things from the window: the LATEST cron-sourced row per sweep (liveness
-- and slowness), and every failing row (the silent-200 report). Both are
-- bounded by construction: one row per sweep, plus at most 200 failures,
-- so the result cannot grow with fleet chatter and can never hit the row
-- cap. Mirrors cron_http_failures directly above it in
-- 20260822101229_cron_sweep_watchdog.sql.
--
-- grants: cron_sweep_run_evidence is service_role only (granted below);
-- the watchdog route calls it with the service client. Creates no tables.

create or replace function public.cron_sweep_run_evidence(since_minutes integer)
returns table (
  sweep text,
  finished_at timestamptz,
  duration_ms integer,
  ok boolean,
  error_count integer,
  errors jsonb
)
language sql
stable
security definer
-- Pinned search_path: a security definer function without one can be
-- hijacked through a caller-controlled path.
set search_path = pg_catalog, public
as $$
  (
    select t.sweep, t.finished_at, t.duration_ms, t.ok, t.error_count, t.errors
    from (
      select distinct on (r.sweep)
        r.sweep, r.finished_at, r.duration_ms, r.ok, r.error_count, r.errors
      from public.cron_sweep_runs r
      where r.source <> 'direct'
        and r.finished_at > now() - make_interval(mins => greatest(since_minutes, 1))
      order by r.sweep, r.finished_at desc
    ) t
  )
  union
  (
    select r.sweep, r.finished_at, r.duration_ms, r.ok, r.error_count, r.errors
    from public.cron_sweep_runs r
    where r.source <> 'direct'
      and r.finished_at > now() - make_interval(mins => greatest(since_minutes, 1))
      and (r.ok = false or r.error_count > 0)
    order by r.finished_at desc
    -- Bounded: a fleet-wide bad night could otherwise return every failing
    -- row in the window and turn one health check into a database dump.
    limit 200
  );
$$;

revoke execute on function public.cron_sweep_run_evidence(integer) from public;
grant execute on function public.cron_sweep_run_evidence(integer) to service_role;
