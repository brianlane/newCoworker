---
name: undoing-a-claim-needs-ownership-cleared
description: Clearing routing.claimed_by without clearing contacts.owner_employee_id makes route_to_team re-assign the lead instantly
metadata:
  type: project
---

A claim writes TWO places: `routing.claimed_by` on the run, and
`contacts.owner_employee_id` on the contact. Undoing only the first is not
undoing the claim. `route_to_team` prefers an existing contact owner and hands
the lead straight back with no claim reply at all ("New lead for a contact you
already own, so it's yours, no reply needed"), so a run requeued with the
ownership still in place re-closes within seconds and re-fires the owner's
claim notice.

Seen 2026-08-24 repairing four falsely-claimed Amy Laidlaw runs: all four
re-closed on the first worker tick and texted Amy the same false
"X confirmed they spoke with <lead>" a second time.

**Why:** ownership is a separate, longer-lived fact than the run's claim state,
and it outranks the team race by design.

**How to apply:** clear `contacts.owner_employee_id` FIRST, verify it by
re-reading the row, and only then requeue. Look the contact up the way
`activeContactOwner` does, `customer_e164.eq.<p>,alias_e164s.cs.{<p>}`, since an
alias-only lead still has an owner, and derive the phone through
`ownershipLeadPhone` rather than the raw `lead_phone` var. Tools:
`debug/clear-contact-owner.ts`, and `scripts/oneshot/repair-misclaimed-lead-followups.ts`
does it inline. Related: [[ownership-never-binds-to-the-sender]],
[[contacts-are-phone-keyed]], [[implicit-contact-owner]].
