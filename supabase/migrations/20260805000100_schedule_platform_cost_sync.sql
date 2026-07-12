-- Schedule the platform-cost-sync Edge cron daily at 11:10 UTC (4:10am
-- Phoenix — after the day's Telnyx MDRs for yesterday have settled, before
-- the operator's morning).
--
-- The job fires `platform-cost-sync`, which bridges to
-- /api/internal/platform-cost-sync: pulls Telnyx detail records (rolling
-- last-7-days window, delete+insert into telnyx_cost_daily) and snapshots
-- the Hostinger billing subscriptions into hostinger_vps_costs. The admin
-- Costs and Usage pages read those tables.
--
-- Secrets required (already in Supabase Vault; see
-- `20260422000000_schedule_edge_crons.sql` for the setup statement):
--   * `internal_cron_secret` — Bearer for the Edge function's cron auth
--   * `edge_base_url`        — https://<project-ref>.supabase.co

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent re-schedule.
do $unschedule$
begin
  perform cron.unschedule('edge-platform-cost-sync')
  where exists (
    select 1 from cron.job where jobname = 'edge-platform-cost-sync'
  );
end
$unschedule$;

select cron.schedule(
  'edge-platform-cost-sync',
  '10 11 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/platform-cost-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
