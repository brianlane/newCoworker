---
name: ownership-never-binds-to-sender
description: "When a flow extracts lead_phone and gets \"\", ownership must NOT fall back to trigger.from; partner alert lines got owned by teammates"
metadata: 
  node_type: memory
  type: project
  originSessionId: b59ec4b9-01b8-4bc1-8f5c-2729fd0f5600
  modified: 2026-08-10T16:23:27.777Z
---

Contact-ownership machinery (routing short-circuit, preferContactOwner,
assignContactOwnerOnClaim, webhook claim gate) resolves the lead's phone
via `ownershipContactPhone`: if `vars` HAS a `lead_phone` key (even ""),
only the extracted value counts; an empty extraction means UNKNOWN. Only
flows with no lead_phone key at all may treat `trigger.from` as the lead.
Rule lives in `_shared/ai_flows/claim_owner_gate.ts` (`ownershipLeadPhone`).

**Why (Danfar, 2026-08-10):** HomeLight withholds the lead's number until
after claiming, so at claim/route time lead_phone is "". The old fallback
used trigger.from = HomeLight's OWN alert line; a Friday claim made Dave
the "owner" of the partner contact, and the next referral was
owner-assigned to him without the team race. Clever's partner line had the
same poisoning. Both cleared with `debug/clear-contact-owner.ts`.

**How to apply:** If a lead skips the offer race with "they already own
this contact" and the contact looks wrong, check whether the "contact" is
a partner/aggregator line and whether lead_phone was empty at route time
(`ai_flow_runs.context.vars`). Partner alert lines saved as customer
contacts are a recurring trap: see also [[self-reply-loop-alias-trap]] and
the "Aaron" bot-loop incident.
