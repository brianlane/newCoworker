-- Raise edge-messenger-jobs-sweep's pg_cron HTTP timeout from 120s to 300s.
--
-- The last mismatch in the cron fleet, and it is a real one. The chain is
--
--   pg_cron (120000)
--     -> Edge messenger-jobs-sweep (REQUEST_TIMEOUT_MS 290_000)
--       -> /api/internal/messenger-worker (maxDuration = 300)
--
-- Supabase 504s an Edge function that has not answered within 150s, so the
-- most this request can take is 150s. pg_cron gave up at 120s, a full 30s
-- before that, and recorded a timeout on runs that were still healthy.
--
-- #1159 missed this one: it was excluded on the incorrect belief that
-- messenger-jobs-sweep dispatches per row like sms-inbound-worker. It does
-- not. It is a plain pass-through bridge that forwards a single request, so
-- the ordinary parity rule applies.
--
-- 300000 rather than the 150000 the ceiling strictly requires, to match the
-- 13 sweeps rescheduled in 20260822063432. tests/cron-timeout-parity.test.ts
-- now discovers this chain instead of relying on a hand-written list, and
-- asserts pg_cron covers min(route, bridge, 150s Edge ceiling).
--
-- Schedule and body are otherwise carried over verbatim from
-- 20260808010000_messenger_channel.sql.
--
-- grants: none (cron schedule only; creates no objects).

select cron.unschedule('edge-messenger-jobs-sweep')
where exists (
  select 1 from cron.job where jobname = 'edge-messenger-jobs-sweep'
);

select cron.schedule(
  'edge-messenger-jobs-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/messenger-jobs-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);
