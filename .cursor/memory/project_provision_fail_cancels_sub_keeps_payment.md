---
name: project-provision-fail-cancels-sub-keeps-payment
description: Amy's biennial term runs on a CANCELED Stripe subscription by design after a failed-but-charged Hostinger order; contract_auto_renew true is the one field that lies
metadata:
  type: project
---

Amy Laidlaw Real Estate (`621a5b0d-c2ad-449f-9d74-9d50e7b27fa3`), Jul 28 2026.
Do NOT re-diagnose this as an unreconciled billing mess. It is a documented,
completed recovery.

**What happened.** The owner paid the Stripe checkout for a Standard biennial
($2,376, invoice `in_1TyJhHFv205jOP2fPkDYLTvB`). Term alignment bought a 2-year
box; Hostinger returned HTTP 402 while STILL completing the order about a
minute later ("failed but charged"). The orphan reconciler scanned before the
VM materialized, so the orchestrator aborted and
`cancelStripeSubscriptionSafely` canceled the brand-new Stripe subscription
OBJECT 24 seconds after creation. The customer's payment stayed captured.

**How it was closed.** `scripts/oneshot/recover-amy-biennial-switch.ts` adopted
the already-paid VM and completed the bookkeeping, creating the active
`subscriptions` row pointing AT the canceled-but-paid Stripe sub on purpose:
the payment is real, the object just cannot renew. Written up in
`docs/tenants/amy-laidlaw-real-estate.md` under Billing ("One durable
caveat"). The box id changed in the process: `1800980` became `1863856`.

**So the row is correct and the money is not stranded.** Owner decision Aug 28
2026: no refund.

**The one field that is genuinely false: `contract_auto_renew: true`.** There is
no live Stripe subscription and no commitment schedule, so nothing can renew on
2028-07-28. Two consumers misread it:
- `src/app/dashboard/billing/page.tsx` renders auto-renew ON in `PlanCard`, a
  promise that cannot be kept.
- `src/lib/billing/contract-term-nudge.ts` excludes any `contract_auto_renew`
  row from the rollover nudge AND retires it from the partial index, so she
  gets no warning email before the term lapses.

Set it to `false` and reality matches behaviour: nothing auto-renews, and the
nudge fires in the 5-business-day window pointing at the "Start a new contract"
CTA, which is the documented path back onto a contract rate. It must be a
DIRECT DB write: `/api/billing/auto-renew` calls `ensureCommitmentSchedule`
first, which fails against a canceled subscription.

Generalizes: a term row can point at a canceled Stripe sub legitimately, so
never infer "broken billing" from `status active` + canceled Stripe object.
Check the tenant dossier and `scripts/oneshot/` first.
Related: [[project_stripe_period_moved_to_items]].
