-- Schedule the tendlc-attach-retry Edge function via pg_cron + pg_net.
--
-- Why every 5 minutes:
--   The retry candidate query already filters out rows attempted in the
--   last `staleAfterSeconds` (default 5 min), so the cron interval is the
--   floor. A 5-minute cadence drains a 25-row backlog (one cron tick) in
--   ≤ 25 minutes, while keeping Telnyx API pressure trivial — even at
--   steady-state max throughput we send <300 attaches/hour.
--
-- Call chain:
--   pg_cron → net.http_post → Edge `tendlc-attach-retry`
--                            → Next.js POST /api/internal/tendlc-attach-retry
--                            → attachBusinessDidToCampaign(...) per row.
--
-- Security model mirrors the other edge crons: bearer secret is read from
-- Supabase Vault at schedule-execution time via `public._cron_vault_read`,
-- so rotating the secret doesn't require a migration.
--
-- Cold-start safety:
--   When `TELNYX_10DLC_BRAND_ID` / `TELNYX_10DLC_CAMPAIGN_ID` aren't set
--   yet the route short-circuits with `{ skipped: '10dlc_not_configured' }`
--   in O(1) — no DB scan, no Telnyx call. Safe to schedule before the
--   campaign is approved.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $unschedule$
begin
  perform cron.unschedule('edge-tendlc-attach-retry')
  where exists (
    select 1 from cron.job where jobname = 'edge-tendlc-attach-retry'
  );
end
$unschedule$;

select cron.schedule(
  'edge-tendlc-attach-retry',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/tendlc-attach-retry',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 90000
  );
  $$
);
