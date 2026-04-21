-- Schedule the voice-bridge health-check Edge cron every 5 minutes.
--
-- Background: this is the 4th scheduled Edge job. Its siblings (sms-inbound,
-- settlement-sweep, low-balance-alerts) were scheduled in
-- `20260422000000_schedule_edge_crons.sql`. We keep this one in its own
-- migration so operators can toggle/debug it without touching the others.
--
-- The job fires `voice-bridge-health-alerts`, which pages on:
--   * stale `business_telnyx_settings.bridge_last_heartbeat_at`
--   * stuck `voice_settlements` (first_signal_at old, finalized_at null)
--
-- Secrets required (set once in Supabase Vault — same rotation surface as
-- the sibling crons):
--   * `internal_cron_secret`  — Bearer value for the Edge function's cron auth
--   * `edge_base_url`         — https://<project-ref>.supabase.co
--
-- See `20260422000000_schedule_edge_crons.sql` for the exact Vault setup
-- statement; we deliberately avoid duplicating it here so there's a single
-- source of truth for the secret names.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent re-schedule.
do $unschedule$
begin
  perform cron.unschedule('edge-voice-bridge-health-alerts')
  where exists (
    select 1 from cron.job where jobname = 'edge-voice-bridge-health-alerts'
  );
end
$unschedule$;

-- `public._cron_vault_read(name)` was created in the earlier migration; its
-- grants are already locked down. We reuse it here to avoid re-defining.
--
-- Cadence: every 5 minutes. The voice-bridge heartbeats every 30s, and the
-- default stale threshold is 5 min (10×), so this schedule gives us a
-- maximum detection latency of ~10 minutes.

select cron.schedule(
  'edge-voice-bridge-health-alerts',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/voice-bridge-health-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
