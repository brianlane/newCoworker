-- Schedule the daily channel-liveness check.
--
-- `dispatchUrgentNotification` records whether a SEND worked.
-- `reportFailedChannels` raises an admin error when one FAILS. Neither says
-- anything about the human, so a channel can be completely dead while every
-- row reads `sent`: KYP Ads sent 77 SMS alerts in 30 days to a number with
-- no active SIM, every one carrier-stamped `delivered`, while its WhatsApp
-- leg was being accepted by Meta and dropped on billing error 131042.
--
-- This sweep asks the other question: has a human done anything on this
-- channel lately. Judgement and thresholds live in
-- src/lib/notifications/channel-liveness.ts (pure, 100% covered); the reads
-- and the fleet loop live in channel-liveness-sweep.ts beside it. Output is
-- one system_logs row per unhealthy tenant, admin-only by decision.
--
-- Chain: pg_cron -> Edge channel-liveness-sweep -> /api/internal/channel-liveness-sweep
-- Timeouts: 150000 here >= min(maxDuration 150s, bridge 150s, Edge ceiling 150s).
-- pg_net must not hang up BEFORE the request it made can finish, or a healthy
-- run is cut off early and logged as a timeout. Matches cron-sweep-watchdog,
-- the other chain whose bridge is already pinned to the platform ceiling.
--
-- 06:41 UTC. Hour 04 is the retention-prune cluster (:00 customer memory,
-- :20 system_logs, :40 cron-history-prune, :50 telemetry-events, :55
-- cron-sweep-runs) and this sweep READS notifications and email_log, so
-- landing it on top of those DELETEs is how you get a check that reports a
-- quiet month because the pruner held the table. Hour 06 holds no daily job
-- at all. :41 is not a multiple of 5 (missing the seven */5 sweeps), is not
-- :07 (the hourly aiflow-library-refresh), and is not in the 7/22/37/52
-- usage-pack pattern.
--
-- grants: none (schedule_channel_liveness_sweep): creates no objects, only a
-- cron schedule.

do $unschedule$
begin
  perform cron.unschedule('edge-channel-liveness-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-channel-liveness-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-channel-liveness-sweep',
  '41 6 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/channel-liveness-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
