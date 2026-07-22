-- ---------------------------------------------------------------------------
-- Version stamp note: continues the ahead-of-real-time ledger sequence
-- (see 20260818100100_lead_submissions.sql).
-- ---------------------------------------------------------------------------
-- Schedule the Meta Conversion Leads outbox drain.
--
-- Per-minute pg_cron → Edge `meta-capi-drain` → internal Next route →
-- drainMetaCapiEvents (src/lib/meta/capi-drain.ts). Same vault-read +
-- cron-bearer pattern as edge-messenger-jobs-sweep. The drain is a cheap
-- no-op while no tenant has a CAPI-ready connection (one indexed SELECT
-- finding zero pending rows).

select cron.schedule(
  'edge-meta-capi-drain',
  '* * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/meta-capi-drain',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
