-- HIPAA lane opt-in, per tenant.
--
-- Off for every business. Flipping it on is an ENTERPRISE-only admin action
-- (src/lib/hipaa/tier-gate.ts) that additionally constrains WHERE the tenant's
-- box may be provisioned (src/lib/hipaa/placement.ts): Hostinger's hosting
-- agreement states its services "are not intended to provide a PCI or HIPAA
-- compliant environment", so a HIPAA tenant may not sit on the default fleet.
--
-- Same shape and same tier posture as businesses.data_residency_mode: a plain
-- column with a safe default, with every gate enforced in application code so
-- a tier change is a code change rather than a migration. No new object is
-- created here, so no new Data API grants are needed; the businesses table
-- already carries its service_role grants.

alter table public.businesses
  add column if not exists hipaa_mode boolean not null default false;

comment on column public.businesses.hipaa_mode is
  'Enterprise opt-in HIPAA lane. When true the tenant may only provision onto a HIPAA-eligible placement (customer-owned BYOS today) with data residency at least dual, and PHI-carrying paths degrade (see docs/COMPLIANCE-HIPAA.md). Enforced in src/lib/hipaa/.';
