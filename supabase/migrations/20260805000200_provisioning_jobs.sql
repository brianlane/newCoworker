-- Durable ledger + watchdog for signup provisioning (Jul 14 2026).
--
-- Why: checkout-triggered provisioning runs inside the Stripe webhook's
-- Vercel function. Twice now (Truly Insurance Jul 8, KYP Ads Jul 14) the
-- runtime tore the orchestrator down mid-provision — the tenant stuck at
-- "Provisioning started 5%" with no error row, no retry, and a human had
-- to notice and re-run it by hand. This table makes every provision a
-- claimable job: the webhook enqueues + runs inline (fast path), and a
-- pg_cron watchdog re-runs anything that dies (the orchestrator is
-- idempotent — pool claims, SSH keys, gateway tokens, and the deploy all
-- reuse prior partial work).
--
-- One row per business (PK): a business is either being provisioned or
-- not; retries update in place, and ON DELETE CASCADE cleans up with the
-- account.
create table if not exists provisioning_jobs (
  business_id uuid primary key references businesses(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  attempts smallint not null default 0,
  max_attempts smallint not null default 3,
  -- Orchestrator inputs snapshotted at enqueue so the watchdog can re-run
  -- without re-deriving them from Stripe metadata.
  tier text,
  vps_size text,
  billing_period text,
  last_error text,
  enqueued_at timestamptz not null default now(),
  started_at timestamptz,
  -- Bumped by every recordProvisioningProgress write for the business —
  -- the liveness signal the watchdog uses to tell "slow" from "dead".
  heartbeat_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Watchdog scan: candidate rows only.
create index if not exists idx_provisioning_jobs_active
  on provisioning_jobs (updated_at)
  where status in ('queued', 'running');

alter table provisioning_jobs enable row level security;

comment on table provisioning_jobs is
  'Signup-provisioning ledger + retry queue. RLS on, no policies: service-role only. Enqueued by the Stripe webhook (and admin provisioning paths); stalled rows are re-run by the provisioning-watchdog Edge cron via /api/internal/provisioning-retry.';

-- ---------------------------------------------------------------------
-- Watchdog claim: one stalled job per tick, race-safe.
--
-- Stalled means attempts remain AND the row's liveness signal — its most
-- recent heartbeat, falling back to started/enqueued stamps — is older
-- than p_stale_ms, for BOTH 'queued' and 'running' rows:
--   * queued + stale = the inline runner never got to run (function torn
--     down before after() fired) — EXCEPT when heartbeats are landing,
--     which happens when the runner's best-effort markRunning write failed
--     but the orchestrator is alive (heartbeatProvisioningJob deliberately
--     bumps queued rows too; claiming such a row would start a SECOND
--     provision in parallel — Bugbot High on PR #598).
--   * running + stale heartbeat = torn down mid-provision.
--
-- p_stale_ms must exceed the longest legitimately-silent orchestrator
-- phase (fresh Hostinger purchase + PIS boot ≈ 5-8 min with zero progress
-- rows), so callers pass ~10 minutes.
-- ---------------------------------------------------------------------
create or replace function claim_stalled_provisioning_job(p_stale_ms int)
returns setof provisioning_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
  v_cutoff timestamptz := now() - (p_stale_ms || ' milliseconds')::interval;
begin
  select business_id into v_id
  from provisioning_jobs
  where attempts < max_attempts
    and status in ('queued', 'running')
    and coalesce(heartbeat_at, started_at, enqueued_at) < v_cutoff
  order by enqueued_at
  for update skip locked
  limit 1;

  if v_id is null then
    return;
  end if;

  return query
  update provisioning_jobs
  set status = 'running',
      attempts = attempts + 1,
      started_at = coalesce(started_at, now()),
      heartbeat_at = now(),
      updated_at = now()
  where business_id = v_id
  returning *;
end;
$$;

comment on function claim_stalled_provisioning_job is
  'Watchdog claim of ONE stalled provisioning job (queued-never-started or running-with-stale-heartbeat, attempts remaining). FOR UPDATE SKIP LOCKED; bumping attempts at claim time bounds retries.';

revoke all on function claim_stalled_provisioning_job(int) from public;
grant execute on function claim_stalled_provisioning_job(int) to service_role;

-- ---------------------------------------------------------------------
-- Schedule: provisioning-watchdog every 5 minutes. Same Edge-bridge
-- pattern as vps-billing-posture. The bridge's own timeout may stop
-- awaiting a long retry run — harmless, the Next route runs to completion.
-- ---------------------------------------------------------------------
do
$unschedule$
begin
  if exists (select 1 from cron.job where jobname = 'edge-provisioning-watchdog') then
    perform cron.unschedule('edge-provisioning-watchdog');
  end if;
end
$unschedule$;

select cron.schedule(
  'edge-provisioning-watchdog',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/provisioning-watchdog',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);
