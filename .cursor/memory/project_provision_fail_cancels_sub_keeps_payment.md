---
name: project-provision-fail-cancels-sub-keeps-payment
description: A Hostinger 402 during provisioning cancels the just-minted Stripe subscription but leaves the paid invoice and an active subscriptions row behind
metadata:
  type: project
---

Observed on Amy Laidlaw Real Estate (`621a5b0d-c2ad-449f-9d74-9d50e7b27fa3`),
2026-07-28 22:42 UTC:

1. 22:42:02 — biennial subscription `sub_1TyJhLFv205jOP2fQIDWTpU8` created,
   invoice `in_1TyJhHFv205jOP2fPkDYLTvB` PAID for $2,376.00.
2. 22:42:26 — `provisioning_error`, Hostinger `/api/vps/v1/virtual-machines`
   returned HTTP 402 (card payment could not be completed — OUR Hostinger card,
   not the customer's).
3. Same second — `cancelStripeSubscriptionSafely`
   (`src/lib/billing/change-plan-orchestrator.ts`) canceled the Stripe
   subscription: "cancel a just-minted Stripe sub when we refuse to provision".

**What was left behind:** the customer's $2,376 invoice is still `paid`, zero
credit notes, zero refunds. The local `subscriptions` row still reads
`status: active`, `billing_period: biennial`, period through 2028-07-28. The
tenant is live and taking calls. So the teardown canceled the recurring billing
object but did not refund the customer or reconcile the local row.

Consequence for anything that re-reads Stripe: the customer has NO live Stripe
subscription. A retrieve still returns the canceled object with its final period
on the item, so period reads keep working — but any check that gates on
`status === "active"` in Stripe will disagree with our DB.

Related: [[project_stripe_period_moved_to_items]] — this is the tenant that
surfaced the voice JIT bug.
