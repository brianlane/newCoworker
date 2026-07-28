-- Admin billing pause: local mirror of Stripe's `pause_collection`.
--
-- An operator can pause collection on a tenant's Stripe subscription
-- (behavior "void": invoices are still generated but voided, so the tenant is
-- comped) while service keeps running. Stripe does NOT change the
-- subscription status for this, which is deliberate: the Stripe webhook
-- auto-cancels a tenant whose status becomes past_due/unpaid/paused, and a
-- comped tenant must not be torn down.
--
-- These columns exist so the admin page and the fleet queries can see the
-- pause without a live Stripe round-trip. Stripe remains the source of truth;
-- POST /api/admin/billing-pause and the customer.subscription.updated webhook
-- both write them from the Stripe response.
alter table public.subscriptions
  add column if not exists billing_paused boolean not null default false;

alter table public.subscriptions
  add column if not exists billing_pause_resumes_at timestamptz;

comment on column public.subscriptions.billing_paused is
  'Mirror of Stripe pause_collection being set. true = collection paused (invoices voided), service still running. Subscription status stays active.';

comment on column public.subscriptions.billing_pause_resumes_at is
  'Mirror of Stripe pause_collection.resumes_at: when Stripe auto-resumes collection. Null means the pause runs until an operator resumes it.';
