---
name: project-subscription-hostinger-link-must-be-stamped
description: Hostinger billing id on inventory is not enough; live subscriptions.hostinger_billing_subscription_id is the join the sweeps and fleet audit use. Leftover unpaid pending carts next to a live sibling make a tenant appear twice.
metadata:
  type: project
---

Two true states looked like fleet problems on 2026-08-31 because processors join Hostinger billing subscriptions through `subscriptions.hostinger_billing_subscription_id`, not through `vps_inventory`:

1. **HQ** (`8f3a5c21-...`, vm 1806097). Prepaid one year; Hostinger sub `16BcBrVOTACBI8WdU` next bill 2027-09-05. Inventory had the id. The synthetic Stripe-less subscription row did not, so `debug/audit-fleet-terms.ts` printed `tenant=UNLINKED`. Term-renewal still skips HQ (`stripeless` + null `billing_period`). That skip is correct (shared box with JobArms). The missing stamp was not.

2. **KIN** (`a912aff5-...`). Aug 21 abandoned `pending` checkout next to the Aug 24 paid row. The audit selected `active` and `pending`, so KIN appeared twice under "no Hostinger billing id". PR #1591 reuses a pending row on re-issue and prevents NEW orphans; it does not cancel the leftover.

Going forward:

- `orchestrateProvisioning` stamps the live row after every successful provision (skip-payment and HQ onboard included). Never write null (that wipes a known link).
- Checkout activation and skip-payment call `cancelUnpaidPendingSiblings`, which uses `cancelSubscriptionIfStripeless` so a mid-flight Stripe attach cannot be cancelled.
- The audit joins via inventory as a fallback and lists unpaid pending carts in their own section, not as a missing box.
- Backfill: `scripts/oneshot/reconcile-subscription-hostinger-links.ts` (fill-only stamp, CAS cancel).

Do not infer the owner of a Hostinger sub from the VM list alone when inventory already names the business. Do not cancel a `pending` row that has a `stripe_subscription_id`.
