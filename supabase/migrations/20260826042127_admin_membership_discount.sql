-- ---------------------------------------------------------------------------
-- Admin membership discount: local mirror of the Stripe discount an operator
-- attaches to a LIVE subscription.
--
-- The gap this closes. `promotions` prices a promo code at SIGNUP: it is
-- redeemed on a Checkout Session, and both surfaces that touch an existing
-- subscription (change-plan, reactivate) deliberately refuse a discount. So an
-- operator who wanted to give a paying tenant a retention discount had only
-- all-or-nothing levers: pause collection (comp 100% for a stretch) or move
-- the billing date (comp a gap). Nothing could take 30% off, going forward,
-- from a membership already being billed.
--
-- What is now possible: POST /api/admin/membership-discount mints a coupon
-- scoped to the tenant's OWN plan product and attaches it to their live Stripe
-- subscription. These columns are the read cache of the result, so the admin
-- page, the MRR tile, and the tenant's own billing page can all see the
-- discount without a Stripe round-trip.
--
-- STRIPE STAYS AUTHORITATIVE. Every column here is written FROM a Stripe
-- response, never from what we asked for: the apply/remove route writes them
-- from its expanded subscription, and the customer.subscription.updated
-- webhook keeps them honest when the discount ends, is removed in the Stripe
-- dashboard, or is dropped by a subscription schedule at a phase change.
--
-- Scope: one discount per subscription. Stripe allows several, but an operator
-- lever with an "apply / remove" shape has no sane meaning for a stack of
-- them, so the route overwrites rather than appends and this mirror holds the
-- one that is live. A discount attached OUTSIDE this lever (a coupon added by
-- hand in the Stripe dashboard) is deliberately not adopted into these
-- columns: the webhook cannot expand `discounts`, so it cannot read one, and
-- writing a half-known discount would be worse than not claiming it. The admin
-- panel says so in its own copy rather than implying this mirror is the whole
-- truth about the account.
--
-- No grants are needed: these are columns on an existing table, and
-- public.subscriptions already carries its service_role grant.
-- ---------------------------------------------------------------------------

alter table public.subscriptions
  -- The Stripe coupon behind the live discount. Null = no discount mirrored.
  -- This is also the "is it ours" key: the route mints one coupon per apply
  -- and tags it, so a discount whose coupon id is not this one came from
  -- somewhere else.
  add column if not exists discount_coupon_id text,
  -- Coupon `name`, which is the operator's own label for WHY the discount was
  -- granted ("Retention: outage credit"). Lives on the Stripe object rather
  -- than in a local-only column so there is exactly one source of truth and a
  -- webhook mirror can never clobber a note it does not know about. Stripe
  -- shows it to the customer on the invoice, which is the intent.
  add column if not exists discount_name text,
  -- Exactly one of the two shapes is set, same rule as `promotions`. Percent
  -- is whole points; amount is cents off the invoice.
  add column if not exists discount_percent_off numeric(5, 2),
  add column if not exists discount_amount_off_cents integer,
  -- Stripe coupon duration semantics. 'once' discounts the next invoice only,
  -- which on a prepaid 12/24-month plan is the whole next term.
  add column if not exists discount_duration text,
  add column if not exists discount_duration_in_months integer,
  -- Stripe discount.start: when the discount attached. NOT when it starts
  -- saving the tenant money, a coupon never credits the cycle already paid,
  -- it lands on the next invoice.
  add column if not exists discount_started_at timestamptz,
  -- Stripe discount.end: when a 'repeating' discount stops. Null for 'once'
  -- and 'forever', which is Stripe's own convention for this field.
  add column if not exists discount_ends_at timestamptz;

-- Mirror-shaped, not input-shaped: every constraint has to tolerate the
-- all-null "no discount" state, because clearing the mirror is a normal write
-- (the webhook does it whenever Stripe reports no discount).
alter table public.subscriptions
  drop constraint if exists subscriptions_discount_one_shape;
alter table public.subscriptions
  add constraint subscriptions_discount_one_shape check (
    (discount_percent_off is null and discount_amount_off_cents is null)
    or (discount_percent_off is not null and discount_amount_off_cents is null)
    or (discount_percent_off is null and discount_amount_off_cents is not null)
  );

alter table public.subscriptions
  drop constraint if exists subscriptions_discount_bounds;
alter table public.subscriptions
  add constraint subscriptions_discount_bounds check (
    (discount_percent_off is null or (discount_percent_off > 0 and discount_percent_off <= 100))
    and (discount_amount_off_cents is null or discount_amount_off_cents > 0)
  );

alter table public.subscriptions
  drop constraint if exists subscriptions_discount_duration_known;
alter table public.subscriptions
  add constraint subscriptions_discount_duration_known check (
    discount_duration is null
    or discount_duration in ('once', 'repeating', 'forever')
  );

-- 'repeating' is the only duration Stripe pairs with a month count, and it
-- requires one. Stated as a mirror rule so a null duration (no discount) and
-- a non-repeating duration both pass.
--
-- The `is not null` is load-bearing, not redundant with the `>= 1` beside it.
-- A CHECK passes when its expression evaluates to NULL, so on a repeating row
-- with a null month count `discount_duration_in_months >= 1` would be NULL,
-- the whole constraint would be NULL, and Postgres would ACCEPT exactly the
-- row this constraint exists to reject. Testing for null first makes the
-- branch evaluate to false instead.
alter table public.subscriptions
  drop constraint if exists subscriptions_discount_months_shape;
alter table public.subscriptions
  add constraint subscriptions_discount_months_shape check (
    (
      discount_duration = 'repeating'
      and discount_duration_in_months is not null
      and discount_duration_in_months >= 1
    )
    or (discount_duration is distinct from 'repeating' and discount_duration_in_months is null)
  );

comment on column public.subscriptions.discount_coupon_id is
  'Stripe coupon id behind the live subscription discount applied by /api/admin/membership-discount. Null = no discount. Written only from a Stripe response.';

comment on column public.subscriptions.discount_name is
  'Stripe coupon name: the operator label for why the discount was granted. Shown to the customer on the invoice.';

comment on column public.subscriptions.discount_percent_off is
  'Mirror of the coupon percent_off. Exactly one of percent_off / amount_off_cents is set while a discount is live.';

comment on column public.subscriptions.discount_amount_off_cents is
  'Mirror of the coupon amount_off (cents). Exactly one of percent_off / amount_off_cents is set while a discount is live.';

comment on column public.subscriptions.discount_duration is
  'Mirror of the coupon duration: once | repeating | forever. Null = no discount.';

comment on column public.subscriptions.discount_duration_in_months is
  'Mirror of the coupon duration_in_months. Set if and only if duration is repeating.';

comment on column public.subscriptions.discount_started_at is
  'Mirror of Stripe discount.start: when the discount attached. The discount lands on the NEXT invoice; the cycle already paid is never credited.';

comment on column public.subscriptions.discount_ends_at is
  'Mirror of Stripe discount.end: when a repeating discount stops. Null for once and forever, per Stripe.';
