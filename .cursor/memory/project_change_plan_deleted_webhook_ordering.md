---
name: change-plan-deleted-webhook-ordering
description: A plan change fires customer.subscription.deleted while the old row still looks active; cancel_reason is stamped too late to guard on
metadata: 
  node_type: memory
  type: project
  originSessionId: e000a484-971a-41d7-89ce-7300b68c7bdb
  modified: 2026-08-17T20:39:30.103Z
---

A change-plan cancels the OLD Stripe subscription and builds a new one, so
`customer.subscription.deleted` fires for a tenant who is still active. Anything
in that handler that tears down tenant state must guard against it.

**Do not guard on `cancel_reason`.** In `change-plan-orchestrator.ts` the order
is: step 5 creates the NEW active row (different Stripe id), step 6 cancels the
old Stripe subscription (~line 733), step 7 does the slow box teardown (SSH
stop, Hostinger, ops email), step 8 stamps the old row `canceled` /
`upgrade_switch` (~line 848). That step-8 write is the ONLY
`updateSubscription(previousSubscriptionId, ...)` in the file. The webhook lands
seconds after step 6, so the old row still reads `status: "active"` with a null
`cancel_reason` and the check misses.

Guard on the **replacement** instead: newest row for the business is active and
points at a different Stripe id. True regardless of interleaving, because step 5
precedes step 6. `isUpgradeSwitchDeletion` in `src/lib/billing/upgrade-switch.ts`
accepts that plus `cancel_reason` (for late or replayed delivery).

Fixed Aug 17 2026 in PR #1429, which found `disableAutoReloadForBusiness` had
been firing on every plan change, silently disabling tenants' top-up rules with
nothing to re-enable them. A comment in the webhook had asserted the opposite
ordering, which is what propagated the wrong guard.

Related: [[priority-support-second-stripe-subscription]].
