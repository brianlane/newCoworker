-- Background migration flags on provisioning_jobs (KYP Ads Jul 29 2026).
--
-- Term-renewal / size-migrate call orchestrateProvisioning inline and were
-- never on this ledger, so a mid-deploy Vercel kill left tenants stuck with
-- no watchdog retry. Adding suppress/skip/purpose lets those callers enqueue
-- the same way signup does, while keeping Stripe signup defaults identical.

alter table public.provisioning_jobs
  add column if not exists suppress_owner_notify boolean not null default false;

alter table public.provisioning_jobs
  add column if not exists skip_pool_adopt boolean not null default false;

alter table public.provisioning_jobs
  add column if not exists purpose text not null default 'signup';

-- Drop+recreate the check so re-runs stay idempotent if the column already
-- existed without the constraint (or with an older name).
alter table public.provisioning_jobs
  drop constraint if exists provisioning_jobs_purpose_check;

alter table public.provisioning_jobs
  add constraint provisioning_jobs_purpose_check
  check (purpose in ('signup', 'migrate_size', 'term_renewal'));

comment on column public.provisioning_jobs.suppress_owner_notify is
  'When true, orchestrateProvisioning skips owner email/SMS (background HW migrations).';
comment on column public.provisioning_jobs.skip_pool_adopt is
  'When true, force a Hostinger purchase (term-renewal economics).';
comment on column public.provisioning_jobs.purpose is
  'signup | migrate_size | term_renewal. Non-signup skips the already-online watchdog short-circuit.';

-- Align the Edge bridge wait with the Next route's 1800s maxDuration so
-- long migration retries are not aborted early in the cron audit log.
do $unschedule$
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
    timeout_milliseconds := 1800000
  );
  $$
);

-- grants: none (columns inherit provisioning_jobs service_role grants from 20260805000300).
