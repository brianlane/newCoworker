---
name: project_route_to_team_rotation_vs_broadcast
description: "route_to_team rotation honors roster tags; lead_auto_assign still hardens an unpinned rotation into a hard assignment"
metadata:
  node_type: memory
  type: project
  originSessionId: be0aaf6c-a64e-4058-b212-c867cc2f79fb
  modified: 2026-09-11T22:00:00.000Z
---

`route_to_team` has exactly three recipient modes:

- `agentNames` / `broadcastAll` = broadcast, one shared deadline, first "1" wins.
- `agentName` / `agentRef` / `agentNameVar` = pin to one person.
- none of the above = ROTATION: the worker resolves the roster at execution
  time (active AND `routing_enabled` AND not on time off / out of schedule),
  ordered by `last_offered_at` nulls-first, then offers ONE person at a time.

**Rotation honors roster tags.** After availability, an unpinned rotation
narrows to teammates whose `ai_flow_team_members.tags` cover the lead type
(`filterRosterByLeadTag` in `team_broadcast.ts`). The type comes from an
explicit `teamTagTemplate` when set, otherwise the same inference unowned
alerts use: this run's vars, then the contact note and recent runs for that
phone (`resolveRotationLeadTag`). A pin or named `agentNames` list is not
tag-filtered: the author already said exactly who to offer.
`team_broadcast_enabled` is NOT the rotation opt-out; that remains
`routing_enabled`. Same fail-safe as alerts: a missing type or a tag matching
nobody offers the whole eligible roster rather than no one.

That is why Jason Lane (tags `buyer` only, `routing_enabled` still on) stays
in buyer round-robin and is skipped on seller rotations, including unclaimed
Clever spoke-check `agent_offer` texts. Do not flip his rotation switch to fix
seller offers.

Other consequences that bite:

- **`businesses.lead_auto_assign` is load-bearing only for rotations.**
  Broadcast deliberately ignores it; a rotation honors it and HARD ASSIGNS
  the lead ("it's yours, no reply needed") instead of offering it. Converting a
  broadcast step to a rotation on an account with it ON silently changes
  offers into assignments. Check it before any such conversion.
- **Rotation is much slower**: responseMinutes per person in turn, THEN the
  reminder ladder over everyone offered, then the owner. `unclaimedReminders`
  does not fire per person, only once the roster is exhausted.
- A step `when` holds ONE condition, so a two-condition gate (lead type AND
  price gate) needs a `branch` whose arms carry deterministic `condition`
  objects. `branch.question` is a label, not a model call.

Parked runs survive a flow edit: every park stamps the step ID and
`resolveResumeIndex` relocates by id, so adding or nesting steps is safe as
long as the parked step keeps its id.
