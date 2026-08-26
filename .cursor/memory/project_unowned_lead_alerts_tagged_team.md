---
name: project_unowned_lead_alerts_tagged_team
description: Urgent alerts about an UNOWNED contact now broadcast to the lead-type-tagged roster before the business owner; one shared selector with the AiFlow path
metadata: 
  node_type: memory
  type: project
  originSessionId: f9767aac-0779-42db-bf9c-8499ab2519f5
  modified: 2026-08-15T18:34:37.106Z
---

Shipped 2026-08-15, PR #1397, merged and live on main.

Amy's rule, in her words: "leads asking for a call means serious / asking for
a human, and unowned/unclaimed should go to all employees respective to seller
vs buyer employees before Amy broadcasted."

**Before:** `contact_owner_target.ts` had two rungs, contact owner and
business owner. A null `owner_employee_id` resolved straight to the owner, so
a Clever seller's two `notify_team` alerts both went to Amy alone and neither
seller-covering teammate was told. Telemetry said so plainly the whole time:
`reason: "contact_unowned", target: "business_owner"`.

**Now:** a team rung sits between them. Selection lives in
`supabase/functions/_shared/team_broadcast.ts` (`selectBroadcastTeam` plus
`broadcastTagMatched`) and BOTH the urgent-alert dispatcher and the AiFlow
worker's `alertBroadcastTeam` call it, so they cannot drift.

Load-bearing details that are easy to undo by accident:

- Only an EMPTY eligible set falls through to the owner.
- Amy stays the backstop for free: her roster row sets
  `team_broadcast_enabled = false`. Do not "fix" that flag.
- The tag filter FAILS SAFE. A tag nobody carries alerts everyone eligible.
- Email stays with the business owner on a broadcast (all four of Amy's
  roster rows have a null email).
- WhatsApp sits out a broadcast entirely: that leg is single recipient.
- `contact_not_found` still goes owner-direct, on purpose.
- `notify_team` gained an optional `leadType` ("seller"/"buyer").

**Trap:** the repo-root `npx tsc --noEmit` EXCLUDES `supabase/functions`, so
edits to the worker or `_shared` can typecheck clean locally and fail the
Edge Functions Typecheck (Deno) job. Run
`deno check --node-modules-dir=none supabase/functions/*/index.ts` before
pushing. Related: [[project_roster_member_tags]],
[[project_informational_team_alert_gets_replied_1]],
[[feedback_check_for_a_shared_mechanism_first]].
