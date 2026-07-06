-- Schedule the hardware-escalation advisor Edge cron daily at 14:00 UTC
-- (7am Phoenix — the digest lands at the start of the operator's day).
--
-- The job fires `hardware-escalation-advisor`, which scans active
-- starter/standard tenants for sustained load (concurrency saturation,
-- voice/SMS utilization, on-box error logs) and emails the ops inbox a
-- digest recommending manual hardware escalation via the admin panel.
-- At most one email per tenant per ISO week (usage_cap_alerts guard,
-- kind `hardware_escalation_advice`).
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
  perform cron.unschedule('edge-hardware-escalation-advisor')
  where exists (
    select 1 from cron.job where jobname = 'edge-hardware-escalation-advisor'
  );
end
$unschedule$;

select cron.schedule(
  'edge-hardware-escalation-advisor',
  '0 14 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/hardware-escalation-advisor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
