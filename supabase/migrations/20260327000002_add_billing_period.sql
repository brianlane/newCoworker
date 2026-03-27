-- Add billing period and renewal tracking to subscriptions
-- Supports 24-month (biennial), 12-month (annual), and 1-month (monthly) commitments

alter table subscriptions
  add column if not exists billing_period text
    check (billing_period in ('monthly', 'annual', 'biennial')),
  add column if not exists renewal_at timestamptz,
  add column if not exists commitment_months integer;
