---
name: project-implicit-contact-owner
description: A one-person owner roster owns its contacts at READ time; never fold that into a field a write echoes back
metadata:
  type: project
---

Shipped Aug 18 2026 (PR #1500). A null `contacts.owner_employee_id`
resolves at read time to the sole ACTIVE roster member, but only when that
member's phone matches `businessOwnerNumbers` (forward cell, alert phone,
onboarding phone). A solo business whose one roster row is an assistant keeps
its unowned contacts. Rule lives in `src/lib/contacts/owner-attribution.ts`
(import-free), the read in `src/lib/db/implicit-contact-owner.ts`.

Nothing is written, deliberately: hiring a teammate changes the answer with no
backfill, and the claim path's compare-and-swap on `.is("owner_employee_id",
null)` still fires.

**Why:** the trap Bugbot caught. `get_contact` and the contact GET route are
read-modify-WRITE shapes: `update_contact` persists whatever
`owner_employee_id` it is handed, and its own tags field tells the model to
read current values from `get_contact` first. Resolving the implicit owner
into that field would have let a routine tag edit stamp an owner nobody
assigned, fire `owner_assigned`, and hide the row from the claim CAS.

**How to apply:** when a derived value shares a name with a writable field,
give it its OWN field (`implicit_owner_employee_id` / `implicitOwnerName`) that
no write schema accepts. Before adding a computed value to any API read,
check whether a client or an AI tool echoes that response back into a write.
Analytics `claimed` counts were left alone on purpose: they measure whether a
claim EVENT happened, not who is responsible. See
[[project-ownership-never-binds-to-sender]].
