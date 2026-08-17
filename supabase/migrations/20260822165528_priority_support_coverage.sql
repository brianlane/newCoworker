-- Priority support coverage: the sellable $400/month add-on.
--
-- Priority call/video support already existed as an entitlement
-- (businesses.priority_support_until, gated by hasPrioritySupportForTier), but
-- only as a free 30-day rider on a white-glove package purchase plus a
-- permanent grant for enterprise. This table makes it purchasable on its own.
--
-- It is its OWN month-to-month Stripe subscription, never a line item on the
-- membership subscription. NOTE: the original comment here claimed Stripe
-- forbids the alternative ("every item must share a billing interval"). That
-- was wrong; Stripe only requires each item's period to be a multiple of the
-- shortest, so month/1 rides a month/24 subscription fine. It stays separate
-- because change-plan rebuilds the membership and would destroy a line item,
-- the 409 plan_unchanged guard blocks adding one mid-term, and the 30-day
-- refund carve-out matches lines on the membership invoice. Riding it at the
-- plan's cadence (what the usage packs do) would also prepay support for the
-- whole term, inverting the product rule: cancel any month, never locked in.
-- (Comment-only correction; this migration is already applied and its schema
-- is unchanged. See src/lib/plans/priority-support.ts.)
--
-- This is the FIRST place the repo runs two concurrent Stripe subscriptions on
-- one business, so the Stripe webhook gates on a `subscriptionKind` metadata
-- marker to keep this subscription from being mistaken for the membership one.
-- Catalog + status helpers: src/lib/plans/priority-support.ts.

create table if not exists public.priority_support_subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- The SECOND Stripe subscription on this customer. Never equal to
  -- subscriptions.stripe_subscription_id for the same business.
  stripe_subscription_id text not null unique,
  stripe_customer_id text,
  -- Checkout session that opened it (audit trail + webhook idempotency).
  stripe_session_id text,
  -- active   = renewing
  -- canceling = cancel_at_period_end set, coverage runs to current_period_end
  -- canceled  = Stripe subscription gone
  status text not null default 'active'
    check (status in ('active', 'canceling', 'canceled')),
  started_at timestamptz not null default now(),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  -- Owner email on self-serve, admin email on a comped/admin-initiated start.
  created_by text not null,
  created_at timestamptz not null default now()
);

alter table public.priority_support_subscriptions enable row level security;

drop policy if exists "Service role manages priority_support_subscriptions"
  on public.priority_support_subscriptions;
create policy "Service role manages priority_support_subscriptions"
  on public.priority_support_subscriptions for all
  using (auth.role() = 'service_role');

grant select, insert, update, delete
  on table public.priority_support_subscriptions to service_role;

-- The structural guard against double-billing a tenant $400/month. Worth more
-- than any application-level check: a raced double click, a retried webhook,
-- or an admin and an owner acting at once all collide here instead of
-- silently opening a second subscription.
create unique index if not exists priority_support_subscriptions_one_live_per_business
  on public.priority_support_subscriptions (business_id)
  where status <> 'canceled';

create index if not exists priority_support_subscriptions_business_idx
  on public.priority_support_subscriptions (business_id, created_at desc);

-- Idempotence stamp for the expiry-warning email, mirroring
-- subscriptions.contract_term_nudge_sent_at. Stamped BEFORE the send, so an
-- overlapping sweep or a crash mid-send cannot double-email.
alter table public.businesses
  add column if not exists priority_support_nudge_sent_at timestamptz;

comment on column public.businesses.priority_support_nudge_sent_at is
  'When the priority-support expiry warning was last emailed. NULL = never. Reset when a new coverage window opens.';

-- Partial index matching the sweep's scan predicate exactly: unstamped rows
-- with a coverage window still open. Stamped rows leave the index entirely.
create index if not exists businesses_priority_support_nudge_scan_idx
  on public.businesses (priority_support_until)
  where priority_support_nudge_sent_at is null
    and priority_support_until is not null;

-- grants: none (businesses_priority_support_nudge_scan_idx): index only
-- grants: none (priority_support_subscriptions_one_live_per_business): index only
-- grants: none (priority_support_subscriptions_business_idx): index only
-- grants: none (edge-priority-support-nudge-sweep): pg_cron runs it as owner

-- Daily expiry warning.
--   pg_cron -> net.http_post -> Edge `priority-support-nudge-sweep`
--                            -> Next.js POST /api/internal/priority-support-nudge-sweep
do $unschedule$
begin
  perform cron.unschedule('edge-priority-support-nudge-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-priority-support-nudge-sweep'
  );
end
$unschedule$;

-- Daily 15:35 UTC, another 10 minutes after the contract-term nudge so the
-- three billing emails never contend for the same minute.
select cron.schedule(
  'edge-priority-support-nudge-sweep',
  '35 15 * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/priority-support-nudge-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    -- 300s, matching what 20260822063432 raised the other sweeps to. The Edge
    -- bridge 504s at 150s and the route caps at 150s, so this is the outer of
    -- the three timeout layers, not the binding one.
    timeout_milliseconds := 300000
  );
  $$
);
