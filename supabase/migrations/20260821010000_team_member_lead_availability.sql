-- Per-employee lead availability: WHICH ways a roster member may be handed a
-- lead, independent of whether they are on the roster at all.
--
-- The gap this closes (Amy Laidlaw, Jul 20 2026): routing HomeLight to Amy AND
-- Dave simultaneously required Amy on ai_flow_team_members, because broadcast
-- claims are matched by roster phone. But roster membership is GLOBAL, so the
-- one change she asked for (one flow, one broadcast) also entered the owner
-- into the round-robin rotation of every unpinned route_to_team step in the
-- tenant. "Be reachable by this specific offer" and "take leads in rotation"
-- were the same bit, and they are not the same decision.
--
-- Three flags, because the engine has three distinct ways to choose a
-- recipient and an owner can reasonably want any subset:
--
--   routing_enabled          the one-at-a-time round robin (pickNextAgent),
--                            the hard auto-assign that reuses that same pick
--                            (businesses.lead_auto_assign), the
--                            preferContactOwner first-offer preference, and
--                            single-agent pins (agentName / agentRef /
--                            agentNameVar). The pin case is deliberate: off
--                            behaves exactly like a deactivated member, so a
--                            pinned-but-unavailable teammate falls through to
--                            the owner fallback instead of silently
--                            overriding the owner's own setting.
--   named_broadcast_enabled  route_to_team broadcast mode with an explicit
--                            agentNames list (Amy's HomeLight step).
--   team_broadcast_enabled   route_to_team broadcastAll, today the team-first
--                            human handoff (businesses.needs_human_team_first).
--
-- `active` stays the master switch above all three: false is out of
-- everything, as before.
--
-- NOT gated by these flags, and the worker says so at each site: teammate
-- hand-off SENDS (send_sms toAgentName / toAgentNameVar / a templated phone
-- that resolves to a roster row) are staff messaging rather than lead
-- distribution, and every staff-detection read stays flag-blind so a
-- routing-off teammate is still never filed as a customer.
--
-- Owner-facing notices never read the roster at all (they resolve
-- business_telnyx_settings.forward_to_e164), so keep-for-owner alerts, the
-- roster-exhausted fallback, and claim notices are unaffected by any of this.

alter table public.ai_flow_team_members
  add column if not exists routing_enabled boolean not null default true,
  add column if not exists named_broadcast_enabled boolean not null default true,
  add column if not exists team_broadcast_enabled boolean not null default true;

comment on column public.ai_flow_team_members.routing_enabled is
  'When false, route_to_team never offers this member a lead through the round-robin rotation, lead_auto_assign, preferContactOwner, or a single-agent pin (agentName/agentRef/agentNameVar) - a pin on them falls through to the owner fallback, same as a deactivated member. Default true.';
comment on column public.ai_flow_team_members.named_broadcast_enabled is
  'When false, this member is skipped when a route_to_team step lists them in an explicit agentNames broadcast. Default true.';
comment on column public.ai_flow_team_members.team_broadcast_enabled is
  'When false, this member is skipped by route_to_team broadcastAll fan-outs (the team-first human handoff). Default true.';

-- No new object here, so no new Data API grant: ai_flow_team_members already
-- carries its service_role grants.
