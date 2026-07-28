-- ---------------------------------------------------------------------------
-- Promotions: admin-authored promo codes for platform memberships.
--
--   promotions            - one row per code. The admin creates it on
--                           /admin/promotions; the row is the lifecycle source
--                           of truth (active toggle, active-date window,
--                           redemption cap, which tiers and billing periods it
--                           may be used on) and carries the Stripe ids that
--                           carry the money.
--   promotion_redemptions - one row per redeemed checkout, keyed by the Stripe
--                           Checkout Session id so webhook retries cannot
--                           double-count. Feeds the per-promotion stats.
--
-- WHY THE ROW GATES AND NOT STRIPE. A Stripe coupon is immutable once created
-- (percent_off / amount_off can never change), a promotion code has no start
-- date, and its redeem_by and max_redemptions are fixed at creation. An admin
-- surface with real CRUD needs all of those editable. Every redemption in this
-- product flows through our own validate + checkout path (we never turn on
-- Stripe Checkout's allow_promotion_codes field, because it cannot coexist
-- with the pre-applied monthly intro coupon), so the row can authoritatively
-- enforce lifecycle while Stripe only prices the discount. The Stripe
-- promotion code's own `active` flag is kept in step as a backstop, and
-- editing a discount VALUE mints a replacement coupon + code.
--
-- Scope: new signups only, starter/standard. Enterprise pricing is bespoke and
-- lives in enterprise_deals.
-- ---------------------------------------------------------------------------

create table if not exists public.promotions (
  id uuid primary key default gen_random_uuid(),
  -- Customer-facing string, stored uppercase and unique (the citext-free
  -- convention here: the app upper-cases before every read and write). The
  -- charset is Stripe's: promotion codes accept only letters, digits, and
  -- dashes, so anything else would be rejected at coupon-mint time instead.
  code text not null check (
    code = upper(code)
    and char_length(code) between 3 and 40
    and code ~ '^[A-Z0-9-]+$'
  ),
  -- Internal label shown in the admin table, e.g. "Summer 2026 launch".
  name text not null check (char_length(name) between 3 and 120),
  -- Exactly one of the two discount shapes, enforced below. Percent is whole
  -- points (Stripe accepts fractions, the admin form does not need them);
  -- amount is cents off the plan line.
  percent_off numeric(5, 2) check (percent_off > 0 and percent_off <= 100),
  amount_off_cents integer check (amount_off_cents >= 100 and amount_off_cents <= 100000000),
  -- Stripe coupon duration semantics. 'once' discounts the first invoice,
  -- which on a prepaid 12/24-month plan is the whole prepaid term.
  duration text not null default 'once' check (duration in ('once', 'repeating', 'forever')),
  duration_in_months integer check (duration_in_months >= 1 and duration_in_months <= 36),
  -- Which memberships the code may be redeemed against. Empty is not allowed:
  -- a code that applies to nothing is a bug, not a configuration.
  allowed_tiers text[] not null default '{starter,standard}',
  allowed_periods text[] not null default '{monthly,annual,biennial}',
  -- Active-date window. starts_at defaults to now (live immediately);
  -- ends_at null means no end. Both are editable after creation, which is the
  -- reason the window lives here rather than on the Stripe coupon.
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  -- Null means unlimited. Counted against promotion_redemptions.
  max_redemptions integer check (max_redemptions >= 1),
  -- The per-promotion toggle on the admin page.
  active boolean not null default true,
  -- Stripe ids for the CURRENT discount. A discount edit replaces both.
  stripe_coupon_id text not null,
  stripe_promotion_code_id text not null,
  -- Admin email that authored the promotion (audit trail).
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint promotions_one_discount_shape check (
    (percent_off is not null and amount_off_cents is null)
    or (percent_off is null and amount_off_cents is not null)
  ),
  -- 'repeating' is the only duration Stripe pairs with a month count, and it
  -- requires one.
  constraint promotions_duration_months_shape check (
    (duration = 'repeating' and duration_in_months is not null)
    or (duration <> 'repeating' and duration_in_months is null)
  ),
  constraint promotions_window_ordered check (ends_at is null or ends_at > starts_at),
  constraint promotions_scope_not_empty check (
    array_length(allowed_tiers, 1) >= 1 and array_length(allowed_periods, 1) >= 1
  ),
  constraint promotions_tiers_known check (allowed_tiers <@ array['starter', 'standard']),
  constraint promotions_periods_known check (
    allowed_periods <@ array['monthly', 'annual', 'biennial']
  )
);

-- The redemption lookup: one promotion per code string, ever.
create unique index if not exists promotions_code_idx on public.promotions (code);

-- The admin table's default ordering.
create index if not exists promotions_created_at_idx on public.promotions (created_at desc);

alter table public.promotions enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated denied by design.
-- The public code-preview route reaches this through the Next.js server, which
-- returns only whether the code is valid and how much it takes off.
grant select, insert, update, delete on table public.promotions to service_role;

create table if not exists public.promotion_redemptions (
  id uuid primary key default gen_random_uuid(),
  -- Restrict, not cascade: a promotion with redemptions may only be
  -- deactivated, never deleted, so the attribution survives.
  promotion_id uuid not null references public.promotions(id) on delete restrict,
  business_id uuid not null references public.businesses(id) on delete cascade,
  tier text not null check (tier in ('starter', 'standard')),
  billing_period text not null check (billing_period in ('monthly', 'annual', 'biennial')),
  -- Idempotency key: Stripe re-delivers checkout.session.completed on ack
  -- timeouts, manual replays, and delivery sweeps.
  stripe_session_id text not null,
  -- What Stripe actually took off (session.total_details.amount_discount), so
  -- the stats report real dollars rather than the promotion's nominal value.
  amount_discounted_cents integer not null default 0 check (amount_discounted_cents >= 0),
  created_at timestamptz not null default now()
);

create unique index if not exists promotion_redemptions_session_idx
  on public.promotion_redemptions (stripe_session_id);

-- The stats query: count, sum, and last-redeemed per promotion.
create index if not exists promotion_redemptions_promotion_idx
  on public.promotion_redemptions (promotion_id, created_at desc);

alter table public.promotion_redemptions enable row level security;
-- No policies: service_role only, same posture as promotions.
grant select, insert, update, delete on table public.promotion_redemptions to service_role;

comment on table public.promotions is
  'Admin-authored promo codes for starter/standard memberships. The row is the lifecycle source of truth (active toggle, starts_at/ends_at window, redemption cap, allowed tiers and billing periods) because Stripe coupons are immutable and promotion codes have no editable window; Stripe only prices the discount. Redeemed at signup checkout only.';
comment on column public.promotions.stripe_coupon_id is
  'Coupon backing the CURRENT discount. Editing percent_off/amount_off_cents mints a replacement coupon + promotion code (Stripe coupons are immutable) and rewrites both id columns.';
comment on table public.promotion_redemptions is
  'One row per checkout that redeemed a promotion, unique on the Stripe Checkout Session id so webhook retries cannot double-count. Records the real amount Stripe discounted, which is what the admin stats report.';
