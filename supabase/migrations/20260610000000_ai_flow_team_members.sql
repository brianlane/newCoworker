-- ---------------------------------------------------------------------------
-- AiFlow team roster: deterministic `route_to_team` agent selection.
--
-- The worker previously asked the tenant's Rowboat agent to pick the next
-- team member from the roster in its free-text memory. That is structurally
-- unable to deliver round-robin fairness (the chat call is stateless, so the
-- model cannot know who least recently received a lead) and is only as
-- trustworthy as the LLM's grounding. This table makes the engine own both:
--
--   * selection   - active members ordered by last_offered_at (nulls first),
--                   first one not already tried for this run wins;
--   * fairness    - the worker stamps last_offered_at when it offers a lead,
--                   so the rotation cursor advances across runs.
--
-- When a business has NO rows here the worker falls back to the legacy
-- Rowboat memory-based pick, so existing tenants are unaffected until their
-- roster is seeded.
-- ---------------------------------------------------------------------------

create table if not exists public.ai_flow_team_members (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  active boolean not null default true,
  last_offered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (business_id, phone_e164)
);

-- Selection hot path: active members for a business in rotation order.
create index if not exists ai_flow_team_members_rotation_idx
  on public.ai_flow_team_members (business_id, last_offered_at asc nulls first, created_at asc)
  where active;

alter table public.ai_flow_team_members enable row level security;

drop policy if exists "Owner reads own ai_flow_team_members" on public.ai_flow_team_members;
create policy "Owner reads own ai_flow_team_members"
  on public.ai_flow_team_members for select
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

drop policy if exists "Owner inserts own ai_flow_team_members" on public.ai_flow_team_members;
create policy "Owner inserts own ai_flow_team_members"
  on public.ai_flow_team_members for insert
  with check (business_id in (select id from public.businesses where owner_email = auth.email()));

drop policy if exists "Owner updates own ai_flow_team_members" on public.ai_flow_team_members;
create policy "Owner updates own ai_flow_team_members"
  on public.ai_flow_team_members for update
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

drop policy if exists "Owner deletes own ai_flow_team_members" on public.ai_flow_team_members;
create policy "Owner deletes own ai_flow_team_members"
  on public.ai_flow_team_members for delete
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

comment on table public.ai_flow_team_members is
  'Per-business team roster for AiFlow route_to_team. The worker offers leads to active members in last_offered_at order (nulls first) and stamps last_offered_at on each offer, giving deterministic round-robin rotation. Empty roster = legacy Rowboat memory-based pick.';
comment on column public.ai_flow_team_members.phone_e164 is
  'Agent SMS number in E.164. Unique per business; matched against ai_flow_runs.awaiting_agent_e164 when the agent replies 1/2.';
comment on column public.ai_flow_team_members.last_offered_at is
  'Rotation cursor: stamped by the ai-flow-worker each time this member is offered a lead. Never-offered members (null) sort first.';
