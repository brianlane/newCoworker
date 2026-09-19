---
name: payment-failed-cancel-race
description: invoice.payment_failed auto-cancels via Stripe API; stamp payment_failed before cancel or cancel_reason races to NULL
metadata:
  node_type: memory
  type: project
  originSessionId: payment-failed-resume-checkout
  modified: 2026-09-19T16:00:00.000Z
---

# Payment-failed auto-cancel stamps too late

`invoice.payment_failed` on an **active** row (and `past_due` / `unpaid` /
`paused` on `customer.subscription.updated`) dispatches
`autoCancelOnPaymentFailure` → `buildCancelPlan({ cancelReason: payment_failed })`
which emits Stripe `cancel_subscription`. Stripe then shows
`cancellation_details.reason = cancellation_requested`. That is our API
cancel, not the customer clicking Cancel.

**Scar Fairy, 2026-09-16 ~6:04:48 PM America/Phoenix.** Amex ending 3042,
`card_declined` / `do_not_honor`, sub `sub_1TuFa5Fv205jOP2fl1ze0t2n`. The
executor ran Stripe cancel **before** the DB `cancel_reason=payment_failed`
write. `customer.subscription.updated` / `.deleted` saw an active row with
null reason; the deleted fallback PATCHed `cancel_reason: existing.cancel_reason`
while existing was still null. Result: `status=canceled`, `cancel_reason` NULL,
grace +30d.

Fix (do not drop the auto-cancel policy):

1. `stampPaymentFailedCancel` writes `cancel_reason=payment_failed` **before**
   `executeLifecyclePlan` Stripe cancel, and leaves `status` active so a failed
   Stripe cancel can retry (planner and `invoice.payment_failed` both require
   active).
2. `dispatchExternalStripeCancel` re-reads the row; skip if reason is already
   set and not `stripe_external`.
3. `canceledMirrorPatch` omits `cancel_reason` when the loaded value is null.

Resume after a payment-failed cancel is Checkout (`lifecycleAction=resubscribe`,
existing Stripe customer), not a portal undo. Do not void Scar Fairy's orphan
invoice as part of the product fix. Owner mail on `invoice.payment_failed`
is independent of the lifecycle cancel-confirmation (which this race skipped).
