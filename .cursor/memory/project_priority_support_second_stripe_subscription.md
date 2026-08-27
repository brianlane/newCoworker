---
name: priority-support-second-stripe-subscription
description: "Priority support is the repo's first SECOND concurrent Stripe subscription per business; the webhook gates on a subscriptionKind marker"
metadata: 
  node_type: memory
  type: project
  originSessionId: e000a484-971a-41d7-89ce-7300b68c7bdb
  modified: 2026-08-17T20:39:40.436Z
---

Priority support ($400/month, PR #1429, Aug 17 2026) is the first place this
repo runs **two concurrent Stripe subscriptions on one business**. The invariant
everywhere else is one, and the enterprise-deal handler enforces it explicitly.

It has to be separate: Stripe requires every item on one subscription to share a
billing interval, and a 12/24-month membership bills at `interval_count: 12|24`,
so a month-to-month line cannot ride it. Billing it at the plan's cadence (what
the usage packs do) would prepay support for the term and lock the tenant in.

The webhook tells them apart via `subscriptionKind: "priority_support"` on the
Stripe SUBSCRIPTION metadata. The sharp trap: `invoice.paid` resolves an
unrecognized subscription by its `businessId` metadata and then writes the
period cache onto whatever it found, so without that gate a paid
priority-support invoice overwrites the MEMBERSHIP's 12/24-month period with a
one-month window, re-anchoring `deriveMonthlyQuotaWindow`, the renewal date,
`isCommitmentElapsed`, and the contract-term nudge.

Coverage lives on `businesses.priority_support_until`, pushed forward by each
paid invoice through the monotonic `extendPrioritySupport`. Admin comp uses the
non-monotonic `setPrioritySupportUntil` instead, so an operator can shorten or
clear a window.

Card state precedence (had two bugs): a live subscription row wins, and the
coverage window only decides when there is no row.

Related: [[change-plan-deleted-webhook-ordering]].
