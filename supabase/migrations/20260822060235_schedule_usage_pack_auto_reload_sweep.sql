-- Schedule the usage-pack auto-reload sweep.
--
-- Every 15 minutes, not hourly: a single answered call can burn ten or more
-- voice minutes, so an hourly cadence would let a tenant reach zero and drop
-- a call before the reload lands. Fifteen minutes bounds the worst-case
-- underrun at roughly one long call, which is why the minimum voice threshold
-- is five minutes.
--
-- Offset off the top of the hour (7, 22, 37, 52) to stay clear of the
-- :00/:05 job spike shared with edge-voice-low-balance-alerts.
--
-- The sweep itself is fail-closed on USAGE_PACK_AUTO_RELOAD_ENABLED, so this
-- job is a no-op until that env var is set in the app.

-- grants: none (edge-usage-pack-auto-reload-sweep): pg_cron runs it as owner

do $unschedule$
begin
  perform cron.unschedule('edge-usage-pack-auto-reload-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-usage-pack-auto-reload-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-usage-pack-auto-reload-sweep',
  '7,22,37,52 * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/usage-pack-auto-reload-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    -- Must be >= the route's maxDuration (300s), or pg_cron gives up while
    -- the sweep is still mid-charge. tests/cron-timeout-parity.test.ts pins it.
    timeout_milliseconds := 300000
  );
  $$
);
