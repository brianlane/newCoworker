-- Schedule the nightly cross-channel customer memory summarizer sweep.
--
-- Why nightly (and not more often): the live SMS / voice paths already
-- fire-and-forget the summarizer on each interaction once the gate
-- (interaction_count >= 3, debounce 30s) is satisfied — see
-- src/lib/customer-memory/summarizer.ts. This sweep is a backstop for
-- rows that leaked past the live path: pre-empted Edge invocations,
-- counter-reset races, voice paths that haven't yet wired the
-- fire-and-forget hook (Phase 5), or Rowboat 5xxs that the live path
-- logged-and-dropped.
--
-- Owner-confirmed contract from the cross-channel plan: "Run nightly
-- batch through a low-priority queue so it never preempts a live
-- customer call/text." Scheduling at 04:00 UTC (~21:00 PT, ~00:00 ET)
-- targets the trough of US business-hours customer activity for the
-- typical owner persona we serve.
--
-- The Edge function does the per-row dispatch and exits in <150s; it
-- caps each invocation at BATCH_LIMIT rows. A backlog larger than
-- BATCH_LIMIT drains over multiple nights, which is fine — every row
-- is idempotent and the summarizer's own gate prevents double-runs.
--
-- This migration is idempotent (cron.unschedule + cron.schedule with
-- the same job name re-creates the schedule) and safe to apply in
-- production. The Edge function name MUST match the folder under
-- supabase/functions/ exactly.

do
$body$
begin
  if exists (
    select 1 from cron.job where jobname = 'edge-customer-memory-summarize-sweep'
  ) then
    perform cron.unschedule('edge-customer-memory-summarize-sweep');
  end if;
end
$body$;

select cron.schedule(
  'edge-customer-memory-summarize-sweep',
  -- 04:00 UTC daily. Single nightly run is sufficient — the live
  -- path catches the high-frequency case; this is a backstop.
  '0 4 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/customer-memory-summarize-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    -- 150s ceiling matches the Edge function's own duration limit;
    -- the function caps batch size internally so we never block on
    -- this. If the Edge run gets stuck, pg_cron disconnects cleanly.
    timeout_milliseconds := 150000
  );
  $$
);
