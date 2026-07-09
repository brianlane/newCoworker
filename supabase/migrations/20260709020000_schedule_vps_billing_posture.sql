-- Schedule the daily fleet VPS billing-posture check via pg_cron + pg_net.
--
-- Why daily: the risk horizon is a monthly Hostinger renewal date — a live
-- tenant's box with auto-renew off has weeks of warning, so one check per
-- day (13:00 UTC ≈ 6am Phoenix) catches any drift long before a period end,
-- without adding meaningful Hostinger API pressure.
--
-- Call chain:
--   pg_cron → net.http_post → Edge `vps-billing-posture`
--                            → Next.js POST /api/internal/vps-billing-posture
--                            → checkVpsBillingPosture(...) (auto-heals live
--                              tenants, emails ops any findings).
--
-- Security model mirrors the other edge crons: bearer secret is read from
-- Supabase Vault at schedule-execution time via `public._cron_vault_read`,
-- so rotating the secret doesn't require a migration.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $unschedule$
begin
  perform cron.unschedule('edge-vps-billing-posture')
  where exists (
    select 1 from cron.job where jobname = 'edge-vps-billing-posture'
  );
end
$unschedule$;

select cron.schedule(
  'edge-vps-billing-posture',
  '0 13 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/vps-billing-posture',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 90000
  );
  $$
);
