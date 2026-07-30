-- One-time pre-term contract nudge: email owners on annual/biennial plans
-- with contract auto-renew OFF, 5 business days before term end, that they
-- will roll to month-to-month unless they renew the contract.
--
-- Call chain:
--   pg_cron → net.http_post → Edge `contract-term-nudge-sweep`
--                            → Next.js POST /api/internal/contract-term-nudge-sweep
--
-- Security model mirrors 20260822003140_monthly_intro_nudge.sql:
-- Bearer from Vault (`internal_cron_secret`) via public._cron_vault_read,
-- Edge base URL from Vault (`edge_base_url`).

alter table public.subscriptions
  add column if not exists contract_term_nudge_sent_at timestamptz null;

comment on column public.subscriptions.contract_term_nudge_sent_at is
  'When the pre-term contract rollover nudge email was claimed/sent. Null until the daily sweep stamps it (claim-before-send).';

-- Sweep scan: active term plans with auto-renew off that have not been nudged.
-- cancel_at_period_end / billing_paused / commitment-elapsed checks stay in app.
create index if not exists subscriptions_contract_term_nudge_scan_idx
  on public.subscriptions (stripe_current_period_end)
  where billing_period in ('annual', 'biennial')
    and status = 'active'
    and contract_auto_renew = false
    and contract_term_nudge_sent_at is null;

-- grants: none (subscriptions_contract_term_nudge_scan_idx): index only
-- grants: none (edge-contract-term-nudge-sweep): pg_cron runs it as owner

do $unschedule$
begin
  perform cron.unschedule('edge-contract-term-nudge-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-contract-term-nudge-sweep'
  );
end
$unschedule$;

-- Daily 15:25 UTC, offset 10 minutes after the monthly intro nudge.
select cron.schedule(
  'edge-contract-term-nudge-sweep',
  '25 15 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/contract-term-nudge-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);
