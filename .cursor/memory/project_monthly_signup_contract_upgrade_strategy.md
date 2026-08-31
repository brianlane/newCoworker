---
name: project-monthly-signup-contract-upgrade-strategy
description: Signups buy MONTHLY Hostinger boxes; term hardware is bought later by the contract-upgrade sweep once the refund window closes
metadata: 
  node_type: memory
  type: project
  originSessionId: e034095f-5412-4df8-a8f3-131c22432ce1
  modified: 2026-08-15T16:27:57.175Z
---

Shipped Aug 15 2026 (PRs #1391 machinery, #1393 the flip).

**Before:** a signup bought a box whose Hostinger term matched the customer's
contract, so a 24-month customer funded 24 months of hardware on day one.
Hostinger will not refund us (30 days per box AND 180 days since the account's
last VPS refund), so that box sat behind the customer's own 30-day money-back
window at our risk. That exposure is why a term refund withheld one month of
service.

**Now:** every purchase defaults to `1m` (`DEFAULT_PURCHASE_TERM` in
`src/lib/hostinger/provision.ts`). Term hardware is bought later by
`src/lib/vps/contract-upgrade-sweep.ts` (cron 10:30 UTC, its own run budget,
separate from the 11:00 term-renewal sweep so neither starves the other).

**The one rule both sweeps encode:** VPS runway must reach the tenant's LIVE
`stripe_current_period_end`, and we buy only the term covering the SHORTFALL.
Deriving from Stripe rather than from contract length is what makes the hard
cases fall out: a 24-month tenant who adopted a pooled box with 12 months left
is untouched for 12 months, then buys `1y`, not another `2y`. At renewal
Stripe advances the period end and the next run re-reads it, so we never
predict whether a term renews as a full term or rolls to month-to-month
(`isCommitmentElapsed` shows BOTH happen).

**Three gates, all required:** refund exposure closed (read the refund RIGHT
via `isRefundExposureOpen`, not subscription age, so a spent lifetime refund
qualifies immediately); runway does not cover the contract; the box is inside
the existing 36h renewal window (so prepaid time is never thrown away).

**The term refund deduction is GONE.** A 12/24-month refund now returns the
full term payment less only what a monthly refund also loses: carrier
registration fee, usage already run, non-refundable usage packs. Terms
section 9, both FAQs, the pricing note and the checkout summary were updated
in `en` and `es`. Forward only; past refunds stand as issued.

`change-plan`'s term alignment is gated on the same refund window, so a
customer upgrading their commitment on day 5 waits rather than re-creating
the exposure; the sweep picks them up later.

**Trap:** Hostinger catalog prices are quoted per WHOLE PERIOD. Comparing a
2-year first period against a monthly renewal in period cents reads as a ~9x
price INCREASE and skips every upgrade while the sweep reports itself healthy.
Cross-term comparison must go through cents-per-month
(`src/lib/vps/catalog-pricing.ts`), derived from the price row's own
`period`/`period_unit`.

**Second trap, and it breaks the cost model (Aug 26 2026):** a term change
can move `next_billing_at` WITHOUT updating `billing_period` /
`billing_period_unit` / `renewal_price`. Brian moved the HQ box (VM 1806097,
sub `16BcBrVOTACBI8WdU`) to a one-year period for $155.88. Hostinger pushed
`next_billing_at` a full year out to 2027-09-05 and still reported
`billing_period: 1, billing_period_unit: "month", renewal_price: 1949`. Not
universal: VM 1863856's 2-year term DOES report `2 year` / `35976` correctly,
so the period fields update for some term changes and not others.

Two consequences:
- **Never derive a term LENGTH or a runway from `billing_period`.** Derive it
  from the date, which is the field that actually moved. `src/lib/vps/box-term.ts`
  (PR #1635) is the shared helper; it deliberately shows no term length.
- **`monthly_price_cents` cannot be derived for such a box, and is no longer
  guessed.** `buildHostingerSnapshot` computes `renewal_price /
  billingCycleMonths(billing_period, unit)`; both operands are stale, so it
  priced HQ at $19.49/mo against a real ~$12.99. FIXED in PR #1636, but NOT by
  computing the right number, which is impossible (below). The snapshot now
  emits `null` when `cycleContradictsNextBilling` fires, and the margin engine
  falls back to `HOSTING_MONTHLY_CENTS_BY_SIZE`, LABELED "estimate". For HQ
  that is $11.99 against $12.99, so error $6.50 -> $1.00.

**The real price IS obtainable, from the CATALOG, not the subscription.**
I first concluded the opposite; that was wrong, because I had only probed
`/api/billing/v1/subscriptions`, which is the stale side. `listCatalog("VPS")`
carries per-term prices: KVM 1 is 1949 (1m), **15588 (1y)**, 28776 (2y). The
1y figure is exactly what was paid. What genuinely does NOT exist is an
orders/invoices read endpoint (`/orders` is 405 POST-only; invoices, payments,
transactions, and `subscriptions/<id>` all 404), so the amount PAID is
unreachable, but the PRICE is not.

**Read the term from the JUMP in the billing date, never the span since
purchase.** `created_at` is the ORIGINAL purchase, so `next_billing -
created` covers the whole subscription life: 427 days (14 months) for HQ,
which bought 12, and 91 days for the retired KVM8 that declared 1 month. Only
a sub still inside its FIRST cycle measures right that way. Span-derivation
yields $1.39/mo for HQ, worse than the bug and in the dangerous direction.

**SHIPPED in PR #1669.** `hostinger_billing_terms` (one row per subscription)
stores the last billing date seen plus the inferred term, written on EVERY
sync so a future jump is detectable. `planTermInference` in
`src/lib/vps/term-inference.ts` is pure and holds the precedence: a measured
jump wins; an existing inference is HELD while the date has not moved; a
runway match (within 8% of a catalog term) bootstraps a subscription never
recorded; otherwise #1636's withholding stands. HQ now reads $12.99/mo, and
the `billing_cycle_price_stale` nag is suppressed once a price is recovered.

**Compare billing dates as INSTANTS, never as strings.** Bugbot High on
#1669. Hostinger returns `...T04:23:54Z`; the same instant stored in a
`timestamptz` column comes back from PostgREST as `...T04:23:54+00:00`.
String comparison made every sync look like a move, clearing the term; and
since the bootstrap only runs when no row exists, the recovered price would
have been lost from the SECOND sync onward, permanently. Use `sameInstant`.
Verified in production by running the sync twice: HQ held at $12.99.

**Still open:** nothing on the cost side. If Hostinger ever reverts HQ to
monthly at renewal, the jump detector sees the date move by one cycle and
clears the term, which is the correct behavior.

**Which date field is meaningful depends on the renew state.** `next_billing_at`
is populated while a sub auto-renews; `expires_at` only once it is cancelled or
non-renewing. Live rows carry exactly one, never both. Use `boxTermState` /
`boxTermEndsAt` from `src/lib/vps/box-term.ts` rather than picking inline.
Note `next_billing_at` can sit slightly BEFORE the true expiry on long terms
(VM 1863856: bills 2028-07-14, expires 2028-07-28), which understates runway,
the safe direction.

Related: [[project-orchestrate-input-rebuilt-field-by-field]],
[[project-fleet-redeploy-stale-ssh-key-rows]].
