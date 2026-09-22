---
name: project-hq-postal-address-waiver
description: "HQ sends Prospecting mail with no postal address. Entitlement is enterprise as of 2026-09-22. The row was created standard and was never downgraded. The kvm1 pin stays."
metadata:
  node_type: memory
  type: project
  modified: 2026-09-22T17:15:00.000Z
---

HQ (`8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d`) sends Prospecting email without a
typed postal address. The Marketing page was blocking Automatic mode on
"Add the postal address that goes in the footer of every email" even though
`outreach_settings.postal_address_exempt` was already true.

There was no downgrade. `onboard-hq-tenant.ts` created both `businesses.tier`
and `subscriptions.tier` as **standard** on 2026-07-16 22:10 UTC, and the
create path skips when the row exists, so a re-run cannot rewrite it. The
dossier said enterprise from its first commit on 2026-07-26 (PR #949)
without a database write. Both tier columns were set to **enterprise** on
2026-09-22. `vps_size` stayed `kvm1` and `data_residency_mode` stayed
`supabase`, so the shared box was not replaced and residency did not turn on.

`postalAddressRequiredFor(businessId, tier)` returns false for Enterprise
and for `HQ_BUSINESS_ID`. The id check stays so a Standard label cannot put
the blocker back. Every other Standard tenant still has to type an address.
A stale `postal_address_exempt` on a downgraded customer must not send.

The footer uses a typed address, then `businesses.address`, then the
unsubscribe line alone. HQ's profile address is null. CAN-SPAM has no such
exemption. This is our own compliance judgement.
