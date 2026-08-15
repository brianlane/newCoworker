-- Contract-upgrade provisioning jobs.
--
-- Fleet strategy (Aug 2026): every signup now buys a MONTHLY Hostinger box,
-- and a contract tenant is moved onto term-priced hardware only once their
-- 30-day money-back window has closed, so the platform never holds
-- non-refundable term hardware behind a refundable subscription.
--
-- Two things the provisioning job ledger needs for that:
--
-- 1. A new `purpose`. The existing `term_renewal` sweep replaces a box that
--    is about to renew at full price; this one closes the gap between a
--    tenant's prepaid runway and their contract end. They are driven by
--    separate crons and the purchase cooldown reads `purpose`, so a shared
--    label would let one sweep's purchase suppress the other's.
--
-- 2. `hostinger_term`. The enqueue and the run are separate steps, and the
--    watchdog can re-run a job much later. The term to buy is COMPUTED from
--    the tenant's remaining contract at enqueue time (a 24-month tenant who
--    adopted a box with 12 months of prepaid runway needs a 1y box, not a
--    2y one), so it has to be persisted rather than re-derived from
--    `billing_period` on the retry.
--
-- Both watchdog functions are `returns setof provisioning_jobs`, so the new
-- column flows through them with no function changes.
--
-- grants: none (provisioning_jobs): pre-existing table, service_role-only,
-- already granted by 20260805000300_provisioning_jobs.sql. This migration
-- adds a column and swaps a check constraint; it creates no new object.

alter table public.provisioning_jobs
  add column if not exists hostinger_term text;

comment on column public.provisioning_jobs.hostinger_term is
  'Explicit Hostinger purchase term for this job (1m/1y/2y). Null falls back to deriving the term from billing_period. Persisted so a watchdog re-run buys the term the sweep computed rather than re-deriving a different one.';

alter table public.provisioning_jobs
  drop constraint if exists provisioning_jobs_hostinger_term_check;

alter table public.provisioning_jobs
  add constraint provisioning_jobs_hostinger_term_check
  check (hostinger_term is null or hostinger_term in ('1m', '1y', '2y'));

-- Widen the purpose enum. Dropping and re-adding is how
-- 20260822002126_provisioning_jobs_migration_flags.sql established it, so
-- this stays consistent with that file rather than introducing a second
-- pattern.
alter table public.provisioning_jobs
  drop constraint if exists provisioning_jobs_purpose_check;

alter table public.provisioning_jobs
  add constraint provisioning_jobs_purpose_check
  check (purpose in ('signup', 'migrate_size', 'term_renewal', 'contract_upgrade'));

comment on column public.provisioning_jobs.purpose is
  'What enqueued this job: signup (tenant checkout), migrate_size (hardware resize), term_renewal (replace a box about to renew at full price), or contract_upgrade (move a contract tenant off short-runway hardware once their refund window has closed).';
