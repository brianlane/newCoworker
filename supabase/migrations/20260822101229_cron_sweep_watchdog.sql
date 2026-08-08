-- The cron sweep watchdog: a reader for net._http_response, and the job that
-- runs the check.
--
-- public.cron_sweep_runs (previous migration) answers "did the sweep finish,
-- and what went wrong inside it". It cannot answer "what happened when the
-- sweep never got that far": a run killed by a timeout never reaches the
-- recorder, and its only trace is net._http_response.
--
-- That table is not reachable from the app. It lives in the `net` schema,
-- which is not exposed to PostgREST, so supabase-js cannot select from it
-- even with the service-role key. This function is the narrow, read-only
-- window onto it.
create or replace function public.cron_http_failures(since_minutes integer)
returns table (
  id bigint,
  status_code integer,
  timed_out boolean,
  error_msg text,
  created timestamptz
)
language sql
stable
security definer
-- Pinned search_path: a security definer function without one can be
-- hijacked through a caller-controlled path.
set search_path = pg_catalog, public, net
as $$
  select r.id, r.status_code, r.timed_out, r.error_msg, r.created
  from net._http_response r
  where r.created > now() - make_interval(mins => greatest(since_minutes, 1))
    -- Only failures. A healthy fleet answers thousands of 200s in the six
    -- hours this table retains, and none of them are the watchdog's business.
    and (r.timed_out is true or r.error_msg is not null or r.status_code >= 400)
  order by r.created desc
  -- Bounded: a sustained outage could otherwise return every row in the
  -- retention window and turn one alert email into a database dump.
  limit 200;
$$;

grant execute on function public.cron_http_failures(integer) to service_role;

-- The watchdog job itself.
--
-- 03:30 UTC sits after the four overnight sweeps (subscription-grace 00:15,
-- data-retention 01:35, document-expiration 02:05, analytics-snapshot 02:50)
-- and still inside the ~6h net._http_response retention window of the
-- earliest of them, which expires around 06:15.
--
-- timeout_milliseconds is 150000, matching the reachable budget of the chain:
-- the route declares maxDuration = 150 and the bridge REQUEST_TIMEOUT_MS =
-- 150_000, so min(route, bridge, the 150s Edge ceiling) is 150000 and
-- tests/cron-timeout-parity.test.ts is satisfied. Deliberately NOT the 300000
-- most sweeps use: this route is a couple of indexed reads and one email, so
-- declaring more than the platform can deliver would only add it to
-- KNOWN_ABOVE_EDGE_CEILING for no benefit.
select cron.unschedule('edge-cron-sweep-watchdog')
where exists (
  select 1 from cron.job where jobname = 'edge-cron-sweep-watchdog'
);

select cron.schedule(
  'edge-cron-sweep-watchdog',
  '30 3 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/cron-sweep-watchdog',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
