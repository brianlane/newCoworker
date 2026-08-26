---
name: project-roster-member-tags
description: "ai_flow_team_members.tags records what a teammate handles, so who-covers-what is a fact about the person instead of names typed into each flow"
metadata: 
  node_type: memory
  type: project
  originSessionId: 954ccfd8-d282-4dee-9a62-9fe6b95d9733
  modified: 2026-08-12T04:55:39.313Z
---

`ai_flow_team_members.tags` (text[], added Aug 12 2026, PR #1317) records what
a roster member handles, e.g. `buyer` / `seller` / `both`.

**Why it exists.** Amy's rule "Dave and Gabby take sellers, plus Jason on
buyers" was true in exactly ONE place: the two arms of "Follow Up Requested".
Twelve other route steps knew nothing about it and Jason appeared nowhere else
on the account. Written on the roster, adding a teammate or changing coverage
is one edit rather than thirteen.

**Consumer so far:** `notify_lead_owner` with `unownedFallback: "team"` and
`teamTagTemplate` (a template, so `"{{vars.route_lead_type}}"` sends a buyer
alert to whoever is tagged buyer). That step alerts every active member whose
`team_broadcast_enabled` is not false. It is an ALERT: nobody replies, no
deadline, the run does not park. `route_to_team` with `broadcastAll` is the
offer-shaped alternative and a different thing.

**Everything fails SAFE, deliberately.** Tags are free text with nothing
validating them, so: a tag matching nobody alerts EVERYONE eligible; an
all-empty render means "no filter", not "a tag nobody has"; nobody eligible at
all falls through to the business owner; one failed send does not suppress the
rest. A typo costs noise, never a lead.

**Amy is deliberately UNTAGGED.** Her row already carries
`team_broadcast_enabled=false`, which is what keeps her out of team alerts; a
tag would not change that. She stays on the CLAIM OFFERS as the Aug 8
speed-to-lead patch set them (see [[project-amy-seller-call-policy]]).

Related: [[project-agent-tool-toggles-are-per-channel]] for the other
"capability lives on a row, not in the flow" pattern on this account.
