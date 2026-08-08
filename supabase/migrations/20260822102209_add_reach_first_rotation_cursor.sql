-- The reach ladder's round-robin cursor: when a place_ai_call step sets
-- reachTeammate.rotateFirst, the worker reorders the first N ladder targets
-- least-recently-FIRST first, so two teammates alternate who rings first on
-- live transfers (Amy Laidlaw's ask: rotate Dave and Gabby, Amy last).
--
-- Deliberately a SEPARATE column from last_offered_at, which the
-- route_to_team claim-offer rotation stamps: one Clever lead now fires both
-- a 3-way claim broadcast and up to three reach ladders, and sharing a
-- cursor would let claim offers reshuffle who rings first (and transfers
-- reshuffle who is offered next) behind each other's backs.
--
-- grants: none (column on an existing table that already grants service_role).
alter table public.ai_flow_team_members
  add column if not exists last_reach_first_at timestamptz;

comment on column public.ai_flow_team_members.last_reach_first_at is
  'When this member last rang FIRST on a reach_teammate ladder (rotateFirst cursor; separate from last_offered_at by design).';
