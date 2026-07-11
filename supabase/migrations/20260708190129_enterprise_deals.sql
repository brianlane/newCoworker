-- Enterprise deals: admin-authored custom recurring pricing for enterprise
-- tenants (setup fee + monthly subscription).
--
-- Enterprise accounts are admin-created and Stripe-less (create-client writes
-- an active subscription row with null Stripe ids), so until now there was no
-- way to charge them. A row here is the deal's pricing source of truth: the
-- admin sets setup_cents + monthly_cents on one enterprise business, and the
-- owner pays through the public /enterprise-offer/<pay_token> link, which
-- creates a mode=subscription Stripe Checkout Session with inline price_data
-- (custom monthly recurring line + one-time setup line). The Stripe webhook
-- then flips the deal to 'active' and wires stripe_customer_id /
-- stripe_subscription_id onto the tenant's existing subscriptions row — from
-- that point the tenant renews like any month-to-month subscriber.
--
-- Lifecycle: open → active (Stripe webhook) or open → revoked (admin);
-- active → canceled when the underlying Stripe subscription ends. Mirrors
-- white_glove_offers (20260803000100) for the one-time equivalent.
create table if not exists public.enterprise_deals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- One-time setup fee. May be zero (monthly-only deal); $1M fail-closed cap.
  setup_cents integer not null check (setup_cents >= 0 and setup_cents <= 100000000),
  -- $1.00 .. $1M/mo — fail-closed bounds against typo'd amounts.
  monthly_cents integer not null check (monthly_cents >= 100 and monthly_cents <= 100000000),
  status text not null default 'open' check (status in ('open', 'active', 'revoked', 'canceled')),
  -- Admin email that authored the deal (audit trail).
  created_by text not null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  stripe_session_id text,
  stripe_subscription_id text,
  -- Unguessable capability behind the public /enterprise-offer/<pay_token>
  -- payment link (fresh Checkout Session per visit, so the link never expires).
  pay_token uuid not null default gen_random_uuid()
);

alter table public.enterprise_deals enable row level security;

drop policy if exists "Service role manages enterprise_deals" on public.enterprise_deals;
create policy "Service role manages enterprise_deals"
  on public.enterprise_deals for all
  using (auth.role() = 'service_role');

create index if not exists enterprise_deals_business_idx
  on public.enterprise_deals (business_id, created_at desc);

create unique index if not exists enterprise_deals_pay_token_idx
  on public.enterprise_deals (pay_token);

-- One live (payable or paying) deal per business: a second open deal while
-- one is open/active would create ambiguity about which price the tenant is
-- on — revoke the old one first.
create unique index if not exists enterprise_deals_one_live_per_business_idx
  on public.enterprise_deals (business_id)
  where status in ('open', 'active');
