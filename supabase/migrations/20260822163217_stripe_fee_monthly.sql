-- Real Stripe fees, per calendar month and tenant.
--
-- The margin engine priced Stripe at a flat 2.9% + $0.30 and never checked
-- that against reality. It is wrong whenever the customer's CARD was issued
-- outside the US (Stripe adds ~1.5%), and nothing in the product could
-- surface the gap, because no code read what Stripe actually took.
--
-- This table is the missing read: Stripe balance transactions for the sync
-- window, summed per UTC month and tenant. `src/lib/plans/stripe-fees.ts`
-- derives each tenant's real effective rate from these totals and feeds it
-- back into the amortized monthly fee line, so the margin reflects observed
-- fees without inheriting the lumpiness of a term plan's one big charge.
--
-- `business_id` is NULL for fees we cannot attribute to a tenant (account
-- level Stripe charges, disputes, transactions whose customer matches no
-- subscription row), the same leak-detector bucket convention as
-- telnyx_cost_daily.
--
-- Access: service-role only (RLS on, no policies) via
-- src/lib/db/platform-costs.ts. Nothing bills from these rows.

create table if not exists public.stripe_fee_monthly (
  id bigint generated always as identity primary key,
  -- First day of the UTC calendar month the transactions settled in.
  month_start date not null,
  -- ON DELETE SET NULL: a deleted business's historical fees stay in the
  -- vendor totals, just unattributed.
  business_id uuid references public.businesses(id) on delete set null,
  -- Gross charged, Stripe's cut, and what landed, all in cents. Refunds
  -- and negative adjustments can push these below zero, hence signed.
  gross_cents bigint not null default 0,
  fee_cents bigint not null default 0,
  net_cents bigint not null default 0,
  -- Charge-only subtotals: the same money restricted to real card charges,
  -- excluding refunds and adjustments.
  --
  -- Rate derivation MUST use these, not the totals above. Stripe does not
  -- return the fee when a charge is refunded, so a partial refund lowers
  -- gross while the fee stands still. Deriving from the totals would report
  -- an inflated rate that can land inside the plausible band and be marked
  -- calibrated: authoritative-looking and wrong. The totals stay unrestricted
  -- so they still reconcile against Stripe's own net volume.
  charge_gross_cents bigint not null default 0,
  charge_fee_cents bigint not null default 0,
  -- How many charges produced the charge-only subtotals: the
  -- $0.30-per-charge multiplier when backing out the percentage rate.
  charge_count integer not null default 0,
  synced_at timestamptz not null default now()
);

create index if not exists idx_stripe_fee_monthly_month
  on public.stripe_fee_monthly (month_start desc);
create index if not exists idx_stripe_fee_monthly_business
  on public.stripe_fee_monthly (business_id, month_start desc);

alter table public.stripe_fee_monthly enable row level security;
-- No policies on purpose: anon/authenticated get zero access; the service
-- role bypasses RLS. Same posture as telnyx_cost_daily.

grant select, insert, update, delete on table public.stripe_fee_monthly to service_role;

-- Atomic replace over the synced rolling window, for the same reason as
-- replace_telnyx_cost_window: a failed insert after a successful delete
-- would silently zero the fee line until the next sync, and PostgREST
-- cannot run delete+insert in one transaction client-side. business_id is
-- nullable, so a unique constraint could not key an upsert either.
create or replace function public.replace_stripe_fee_window(
  p_window_start date,
  p_rows jsonb
) returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  inserted integer;
begin
  delete from public.stripe_fee_monthly where month_start >= p_window_start;
  insert into public.stripe_fee_monthly
    (month_start, business_id, gross_cents, fee_cents, net_cents,
     charge_gross_cents, charge_fee_cents, charge_count)
  select
    (r->>'month_start')::date,
    nullif(r->>'business_id', '')::uuid,
    coalesce((r->>'gross_cents')::bigint, 0),
    coalesce((r->>'fee_cents')::bigint, 0),
    coalesce((r->>'net_cents')::bigint, 0),
    coalesce((r->>'charge_gross_cents')::bigint, 0),
    coalesce((r->>'charge_fee_cents')::bigint, 0),
    coalesce((r->>'charge_count')::integer, 0)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke execute on function public.replace_stripe_fee_window(date, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_stripe_fee_window(date, jsonb) to service_role;
