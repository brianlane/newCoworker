---
name: stripe-discounts-empty-string-clears
description: "clearing a Stripe subscription's discounts needs the empty STRING; an empty array silently means \"leave unchanged\""
metadata: 
  node_type: memory
  type: project
  originSessionId: 0ca497ea-f462-475d-8158-39a29b07e65b
  modified: 2026-08-26T05:22:47.053Z
---

On `stripe.subscriptions.update`, the `discounts` field has three meanings and
the intuitive one is a silent no-op:

- `discounts: [{coupon: "co_x"}]` overwrites the subscription's discounts.
- `discounts: []` (or omitted) leaves them **unchanged**.
- `discounts: ""` is the only value that **clears** them.

So a "remove the discount" path written with `discounts: []` returns 200, looks
successful, writes its audit line, and leaves the customer discounted forever.

Two related Stripe facts from the same work:

- A coupon is **immutable**. Percent/amount/duration can never be edited, so
  changing a discount is always mint-a-new-coupon plus attach.
- Deleting a coupon does **not** revoke it from anyone who already has it. So
  detach first, then delete; deleting first retires the object while the
  customer keeps the discount.
- On a `Subscription` object, `discounts` comes back as bare id strings unless
  expanded (`expand: ["discounts.source.coupon"]`), and in the dahlia API the
  coupon lives at `discount.source.coupon`, not `discount.coupon`. **Webhook
  payloads cannot expand**, so a mirror written from a webhook can only ever
  read the empty-array case.

**Why:** all four are the kind of thing that passes tests written against your
own mock and fails silently against real Stripe, on the money path.

**How to apply:** `src/lib/billing/membership-discount.ts` encodes each of
these in a named builder rather than an inline literal, and its tests assert
`params.discounts` is `""` and not `[]`. Reuse those builders instead of
hand-writing a subscription discount payload. See
[[ok-true-is-not-a-commit]] for the same shape of failure: an API call that
succeeds without doing the thing.
