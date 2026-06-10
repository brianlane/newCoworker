-- ---------------------------------------------------------------------------
-- system_logs — unified per-tenant operational log sink.
--
-- One row per noteworthy event from any component that participates in serving
-- a client's AI: the ai-flow-worker and the other Edge functions, the VPS
-- chat-worker (Rowboat / llm-router / Ollama / Gemini callers), Telnyx webhook
-- handlers, and the Next.js app itself. The admin business detail page and the
-- fleet-wide "recent errors" feed read this table; `debug/system-logs.ts`
-- tails it from the CLI.
--
-- Writers all hold the service role (Edge functions, chat-worker, app server),
-- so access is service-role-only — no owner-facing policies.
--
--   source  — the component that EMITTED the log (chat_worker, aiflow, app…);
--             the dependency that failed (telnyx, gemini, ollama, rowboat…)
--             belongs in `event` / `payload`, e.g. source=chat_worker,
--             event=rowboat_call_failed. Free text by design: adding a new
--             component must not require a migration.
--   event   — stable machine-readable name, snake_case.
--   message — human-readable detail (error text, status line).
--   payload — structured context (run_id, job_id, step_index, status codes…).
--
-- Retention (pg_cron, daily): debug/info/warn 30 days, error 90 days.
-- ---------------------------------------------------------------------------

create table if not exists system_logs (
  id bigserial primary key,
  -- Nullable: platform-wide events (fleet rollouts, cron sweeps) have no tenant.
  business_id uuid references businesses(id) on delete cascade,
  source text not null,
  level text not null check (level in ('debug', 'info', 'warn', 'error')),
  event text not null,
  message text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Per-business tail (admin detail page, debug CLI).
create index if not exists idx_system_logs_business_created
  on system_logs (business_id, created_at desc);

-- Fleet-wide error feed (admin dashboard).
create index if not exists idx_system_logs_errors_created
  on system_logs (created_at desc)
  where level = 'error';

-- Retention purge scans.
create index if not exists idx_system_logs_created
  on system_logs (created_at);

alter table system_logs enable row level security;

drop policy if exists "Service role manages system_logs" on system_logs;
create policy "Service role manages system_logs"
  on system_logs for all
  using (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
create or replace function system_logs_prune(
  p_default_max_age interval default interval '30 days',
  p_error_max_age interval default interval '90 days'
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  n int;
  total int := 0;
begin
  delete from system_logs
    where level <> 'error' and created_at < now() - p_default_max_age;
  get diagnostics n = row_count;
  total := total + n;

  delete from system_logs
    where level = 'error' and created_at < now() - p_error_max_age;
  get diagnostics n = row_count;
  total := total + n;

  return total;
end;
$$;

revoke execute on function system_logs_prune(interval, interval) from public;
grant execute on function system_logs_prune(interval, interval) to service_role;

comment on function system_logs_prune(interval, interval) is
  'Deletes system_logs older than the retention windows (non-error 30d, error 90d by default). Scheduled daily via pg_cron.';

-- Plain SQL cron job — no Edge function round-trip needed for a DELETE.
do
$unschedule$
begin
  perform cron.unschedule('system-logs-prune')
  where exists (select 1 from cron.job where jobname = 'system-logs-prune');
end
$unschedule$;

select cron.schedule(
  'system-logs-prune',
  -- 04:20 UTC daily, off the top-of-hour spike shared with other crons.
  '20 4 * * *',
  $$ select system_logs_prune(); $$
);
