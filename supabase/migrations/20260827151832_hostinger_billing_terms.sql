-- What a Hostinger VPS subscription's CURRENT term actually is, when
-- Hostinger's own subscription record no longer says.
--
-- A term change can move `next_billing_at` without updating
-- `billing_period` / `billing_period_unit` / `renewal_price`. Observed on
-- VM 1806097 (2026-08-26): a one-year period was bought for $155.88,
-- Hostinger pushed the billing date a full year out to 2027-09-05, and still
-- reported "1 month" at a $19.49 renewal price. PR #1636 stopped publishing
-- the resulting fiction as an actual; this table is how the RIGHT number is
-- recovered instead.
--
-- The term is read from the JUMP in the billing date, not from the span
-- since purchase: `created_at` is the ORIGINAL purchase, so
-- next_billing minus created spans the whole subscription life (427 days for
-- VM 1806097, i.e. 14 months, against the 12 that were bought). Detecting a
-- jump needs the previous value, and `hostinger_vps_costs` is full-replaced
-- on every sync, so the previous value has to live somewhere that survives
-- the replace. That is this table's whole job.
--
-- One row per Hostinger billing subscription. Keyed on subscription_id
-- rather than vm_id because a rebuilt box can carry two subscriptions, and
-- the term belongs to the subscription that is paying.
create table if not exists public.hostinger_billing_terms (
  subscription_id text primary key,
  -- The billing date as of the last sync. Compared against the incoming
  -- value to spot a term change; this is the field that makes the whole
  -- inference possible, so it is written on EVERY sync, healthy or not.
  observed_next_billing_at timestamptz,
  -- Inferred length of the current paid term, in months. Null while unknown.
  term_months integer check (term_months is null or term_months > 0),
  -- Catalog renewal price for that term, divided by term_months. Null while
  -- unknown. This is what the cost sync publishes as the box's monthly cost.
  monthly_cents integer check (monthly_cents is null or monthly_cents >= 0),
  -- How term_months was arrived at, so a number nobody can re-derive is
  -- never mistaken for a measured one:
  --   'jump'          the billing date moved by this much between two syncs.
  --                   Exact, and the steady-state path.
  --   'runway_match'  bootstrap for a term change that happened BEFORE we
  --                   started recording, where the remaining runway matched
  --                   exactly one catalog term. Inferred once, then frozen.
  source text check (source is null or source in ('jump', 'runway_match')),
  inferred_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.hostinger_billing_terms enable row level security;
-- No policies on purpose (service-role only), matching hostinger_vps_costs.

grant select, insert, update, delete
  on table public.hostinger_billing_terms to service_role;
