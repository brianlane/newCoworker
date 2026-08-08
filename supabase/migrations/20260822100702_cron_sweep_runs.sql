-- Durable outcome ledger for the cron sweep fleet.
--
-- Why this table has to exist: pg_net's http_post is ASYNCHRONOUS, so a
-- pg_cron run only enqueues the request and finishes in milliseconds.
-- cron.job_run_details therefore records "succeeded" whether the sweep ran
-- perfectly, returned a body full of errors, or timed out. The real outcome
-- lands in net._http_response, which is retained for roughly six hours, has
-- no job column, and can only be attributed back to a sweep by reverse
-- engineering its JSON body shape (src/lib/cron/sweep-http-stats.ts).
--
-- The practical effect measured on 2026-08-08: the only way to know how the
-- overnight sweeps went was a human running debug/cron-http-stats.ts inside
-- the six hour window. Three failure modes were invisible entirely:
--   1. the sweep never ran (no row is indistinguishable from a quiet night),
--   2. it answered HTTP 200 with a non-empty errors[] array (every sweep
--      body carries one; nothing looked at it),
--   3. it timed out more than six hours ago.
--
-- Each sweep now writes one row here when it finishes, so (2) becomes a
-- column and history outlives the six hour window. A MISSING row is how (1)
-- and (3) are detected: a sweep that timed out or crashed never gets to
-- write its own completion row, which is exactly what makes absence
-- meaningful here.
create table public.cron_sweep_runs (
  -- Identity, not serial: no sequence grant to keep in step (see
  -- supabase/migrations/CLAUDE.md, "Data API grants").
  id bigint generated always as identity primary key,
  -- The route segment under src/app/api/internal/, e.g. 'analytics-snapshot-sweep'.
  -- tests/cron-sweep-run-coverage.test.ts pins this to the directory name so
  -- the watchdog's expected-sweep list cannot drift from the fleet.
  sweep text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  -- The route's own self-report, the same number it returns as durationMs.
  duration_ms integer not null,
  -- False when the sweep threw. An ok=true row with error_count > 0 is the
  -- silent-200 case: the work ran but part of it failed.
  ok boolean not null,
  error_count integer not null default 0,
  -- Truncated: a fleet-wide sweep can fail for every tenant and we do not
  -- want one bad night to write megabytes.
  errors jsonb not null default '[]'::jsonb,
  -- The rest of the sweep's result body (counts), minus errors/durationMs.
  summary jsonb not null default '{}'::jsonb,
  -- WHO invoked this run: the Edge bridge's name for a pg_cron run, or
  -- 'direct' for anything else.
  --
  -- Not cosmetic. Several internal routes accept the same
  -- INTERNAL_CRON_SECRET bearer from callers that are not pg_cron:
  -- /api/internal/messenger-worker is kicked fire-and-forget by the Meta
  -- webhook (src/app/api/webhooks/meta/route.ts) on every inbound message.
  -- Without this column, busy Messenger traffic would keep writing rows for
  -- messenger-worker while its per-minute cron job was dead, and the
  -- watchdog's missing-row check would never fire for the one sweep whose
  -- whole job is being a retry net. The watchdog counts only cron-sourced
  -- rows toward liveness; direct runs are still recorded, since their
  -- failures are worth seeing.
  source text not null default 'direct'
);

-- The watchdog asks two questions: "did <sweep> finish since <time>" and
-- "what happened across the whole fleet since <time>". One index each.
create index cron_sweep_runs_sweep_finished_idx
  on public.cron_sweep_runs (sweep, source, finished_at desc);
create index cron_sweep_runs_finished_idx
  on public.cron_sweep_runs (finished_at desc);

-- Service-role only: this is operator telemetry, never client-readable.
alter table public.cron_sweep_runs enable row level security;
grant select, insert, update, delete on table public.cron_sweep_runs to service_role;

-- Retention. Every-minute sweeps dominate the row count: 8 of them at 1440
-- runs a day is ~11.5k rows/day, so 30 days is roughly 350k rows, small
-- enough to keep and long enough to see a duration curve bending toward the
-- 150s Edge ceiling before it gets there. Scheduled at 04:55 UTC, offset
-- from the neighbouring prunes (cron-history 04:40, telemetry-events 04:50).
do
$unschedule$
begin
  perform cron.unschedule('cron-sweep-runs-prune')
  where exists (select 1 from cron.job where jobname = 'cron-sweep-runs-prune');
end
$unschedule$;

select cron.schedule(
  'cron-sweep-runs-prune',
  '55 4 * * *',
  $$ delete from public.cron_sweep_runs where finished_at < now() - interval '30 days'; $$
);
