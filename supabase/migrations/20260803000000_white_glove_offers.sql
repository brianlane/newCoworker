-- Custom (admin-authored) white-glove offers.
--
-- The two fixed packages ('setup' $750 / 'buildout' $2,000, catalog in
-- src/lib/plans/white-glove.ts) cover the common cases, but enterprise-ish
-- deals need bespoke pricing: an admin creates a named offer with a custom
-- amount for ONE business, and that business's owner pays it from the billing
-- page through the same inline-price_data Stripe Checkout flow (no Stripe
-- catalog setup needed; this row is the pricing source of truth).
--
-- Lifecycle: open → paid (Stripe webhook, checkout.session.completed with
-- metadata.whiteGloveOfferId) or open → revoked (admin). Paying a custom
-- offer opens the same 30-day priority call/video support window the fixed
-- packages grant; it does NOT touch businesses.white_glove_package (that
-- column stays the fixed-package enum).
create table if not exists public.white_glove_offers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Shown as the Stripe line item + billing card title, e.g.
  -- "White-glove migration + 3 custom AiFlows".
  name text not null check (char_length(name) between 3 and 120),
  description text not null default '' check (char_length(description) <= 500),
  -- $1.00 .. $50,000.00 — fail-closed bounds against typo'd amounts.
  amount_cents integer not null check (amount_cents >= 100 and amount_cents <= 5000000),
  status text not null default 'open' check (status in ('open', 'paid', 'revoked')),
  -- Admin email that authored the offer (audit trail).
  created_by text not null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  stripe_session_id text
);

alter table public.white_glove_offers enable row level security;

drop policy if exists "Service role manages white_glove_offers" on public.white_glove_offers;
create policy "Service role manages white_glove_offers"
  on public.white_glove_offers for all
  using (auth.role() = 'service_role');

create index if not exists white_glove_offers_business_idx
  on public.white_glove_offers (business_id, created_at desc);
