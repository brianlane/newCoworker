-- Schedule the subscription-grace-sweep Edge function via pg_cron + pg_net.
--
-- Runs daily at 00:15 UTC — the :15 offset keeps it clear of the top-of-hour
-- bursts already taken by `sms-inbound-worker` (every minute) and other crons
-- scheduled on the hour, and gives pg_cron enough headroom to flush the
-- preceding minute's queue before this job fires.
--
-- Call chain:
--   pg_cron → net.http_post → Edge `subscription-grace-sweep`
--                            → Next.js POST /api/internal/subscription-grace-sweep
--
-- Security model mirrors `20260422000000_schedule_edge_crons.sql`: the Bearer
-- secret lives in Supabase Vault (`internal_cron_secret`), read at schedule-
-- execution time via `public._cron_vault_read` (SECURITY DEFINER, locked down
-- from anon/authenticated/service_role). The Edge base URL comes from Vault
-- (`edge_base_url`) so we can rotate project refs without touching SQL.
--
-- If either secret is missing at schedule time, the HTTP POST ships an empty
-- URL / empty Bearer and the Edge function returns 401. That's fail-safe —
-- nothing runs until an operator finishes the Vault setup.

-- ──────────────────────────────────────────────────────────
-- Prereqs: pg_cron + pg_net + the `_cron_vault_read` helper should exist
-- from 20260422000000_schedule_edge_crons.sql. Kept here idempotently so
-- this migration can apply on a fresh database that hasn't yet applied the
-- earlier one (migrations always run in timestamp order, but a partial-
-- restore scenario is better safe than sorry).
-- ──────────────────────────────────────────────────────────
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ──────────────────────────────────────────────────────────
-- Idempotency: unschedule any prior copy before scheduling again.
-- ──────────────────────────────────────────────────────────
do $unschedule$
begin
  perform cron.unschedule('edge-subscription-grace-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-subscription-grace-sweep'
  );
end
$unschedule$;

-- ──────────────────────────────────────────────────────────
-- Daily at 00:15 UTC.
-- ──────────────────────────────────────────────────────────
select cron.schedule(
  'edge-subscription-grace-sweep',
  '15 0 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/subscription-grace-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
