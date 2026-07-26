-- Lead availability gains its fourth flag, and with it a coherent model.
--
-- 20260821010000 shipped three flags and one blunt rule: a single-agent pin
-- (route_to_team agentName / agentRef / agentNameVar) obeyed routing_enabled,
-- so turning off rotation ALSO made the person unreachable by a flow that
-- names them. That conflated two different things an owner says:
--
--   "stop feeding me leads off the rotation"   (automatic distribution)
--   "never send me a lead, even a specific one" (unreachable)
--
-- Amy Laidlaw is the case: out of the round robin, but "I want Amy on this
-- one" must still land. So the four flags are two axes, not a list:
--
--                   |  ONE recipient              |  the GROUP
--   ----------------+-----------------------------+---------------------------
--   engine CHOOSES  |  routing_enabled            |  team_broadcast_enabled
--                   |  (round robin, auto-assign, |  (broadcastAll, the
--                   |   preferContactOwner)       |   team-first handoff)
--   ----------------+-----------------------------+---------------------------
--   a flow NAMES    |  named_routing_enabled       |  named_broadcast_enabled
--   them            |  (agentName / agentRef /    |  (an explicit agentNames
--                   |   agentNameVar)             |   list)
--
-- The two axes are independent: each selection mode reads its own flag, so
-- "rotation off, named pins on" and the reverse are both expressible. Nothing
-- is implied from another flag's value, which is what keeps the Employees page
-- switches honest about what they do.
--
-- Default true, so every existing roster keeps behaving as it does today. For
-- rows written between 20260821010000 and this migration that means pins start
-- landing again on a rotation-off member, which is the intent: that was the
-- over-broad behavior, and no tenant configured around it in the meantime.

alter table public.ai_flow_team_members
  add column if not exists named_routing_enabled boolean not null default true;

comment on column public.ai_flow_team_members.named_routing_enabled is
  'When false, a route_to_team step that PINS this member by name (agentName / agentRef / agentNameVar) skips them and falls through to the owner fallback. Independent of routing_enabled, which governs only the engine-chosen rotation. Default true.';

comment on column public.ai_flow_team_members.routing_enabled is
  'When false, route_to_team never offers this member a lead through the round-robin rotation, lead_auto_assign, or preferContactOwner. Does NOT affect a pin that names them (see named_routing_enabled). Default true.';

-- No new object here, so no new Data API grant: ai_flow_team_members already
-- carries its service_role grants.
