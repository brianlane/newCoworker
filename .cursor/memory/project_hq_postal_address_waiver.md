---
name: project-hq-postal-address-waiver
description: "HQ may send Prospecting mail with no postal address. The live row is Standard, so the Enterprise plan waiver does not cover it. The exemption is by HQ_BUSINESS_ID."
metadata:
  node_type: memory
  type: project
  modified: 2026-09-22T17:00:00.000Z
---

HQ (`8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d`) sends Prospecting
email without a typed postal address. Decided because the Marketing page
was blocking Automatic mode on "Add the postal address that goes in the
footer of every email" even though `outreach_settings.postal_address_exempt`
was already true.

Why the plan waiver was not enough: `postalAddressRequiredForTier` exempts
only `tier === "enterprise"`. The live `businesses.tier` and
`subscriptions.tier` are both **standard** (onboarded that way 2026-07-16).
The dossier used to say enterprise. That was wrong, and it is why the page
still showed the blocker: the send path and the panel re-read the tier and
ignore a stale exempt flag, on purpose, so a downgraded customer cannot
keep sending. HQ is the one Standard row that must keep sending.

`postalAddressRequiredFor(businessId, tier)` in `src/lib/plans/prospecting.ts`
returns false for `HQ_BUSINESS_ID` regardless of tier. Save writes
`postal_address_exempt`. The footer still uses a typed address, then
`businesses.address`, and otherwise the unsubscribe line alone. HQ's
profile address is null, so the footer is the unsubscribe line. CAN-SPAM
has no such exemption. This is our own compliance judgement, not a rule
for customers.

Do not widen this to every Standard tenant. A stale `postal_address_exempt`
on anyone else still must not send.
