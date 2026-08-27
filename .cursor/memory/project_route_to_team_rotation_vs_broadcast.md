---
name: project_route_to_team_rotation_vs_broadcast
description: "route_to_team has no tag filter; rotation = every routing_enabled roster member, and lead_auto_assign silently turns a rotation into a hard assignment"
metadata: 
  node_type: memory
  type: project
  originSessionId: be0aaf6c-a64e-4058-b212-c867cc2f79fb
  modified: 2026-08-14T23:25:05.045Z
---

`route_to_team` has exactly three recipient modes and no way to round-robin a
NAMED subset:

- `agentNames` / `broadcastAll` = broadcast, one shared deadline, first "1" wins.
- `agentName` / `agentRef` / `agentNameVar` = pin to one person.
- none of the above = ROTATION: the worker resolves the roster at execution
  time (active AND `routing_enabled` AND not on time off / out of schedule),
  ordered by `last_offered_at` nulls-first, and offers ONE person at a time.

Consequences that bite:

- **No tag filter exists.** `ai_flow_team_members.tags` feeds
  `notify_lead_owner` team alerts only (see [[project_roster_member_tags]]).
  Tagging someone "buyer" does not put them in a race. The only subset control
  a rotation has is the roster's own switches, so a new hire with lead rotation
  on joins every rotation with no flow edit.
- **`businesses.lead_auto_assign` is load-bearing only for rotations.**
  Broadcast deliberately ignores it; a rotation honors it and HARD ASSIGNS the
  lead ("it's yours, no reply needed") instead of offering it. Converting a
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
