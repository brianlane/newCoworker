-- What each roster member handles, as a fact about the PERSON.
--
-- The roster already says whether someone can be routed to or broadcast at
-- (routing_enabled, team_broadcast_enabled, and the two named_* variants). It
-- has never said what KIND of work they take.
--
-- So "Jason handles buyers, not sellers" lived hand-written into the agentNames
-- list of exactly one step of one flow on one tenant, while twelve other route
-- steps knew nothing about it. Adding a teammate, or changing who covers what,
-- meant editing every flow that mentions anyone, which is how a rule ends up
-- true in one place and silently absent everywhere else.
--
-- Free-text rather than an enum on purpose: the useful tags differ per tenant
-- (a real-estate team splits buyer/seller, an insurance one might split auto
-- and home), and a fixed vocabulary would need a migration per tenant idea.
-- The cost is that nothing validates a tag against anything, so every consumer
-- MUST fail safe when a tag matches nobody: alerting everyone is recoverable,
-- alerting no one is not.
alter table public.ai_flow_team_members
  add column if not exists tags text[] not null default '{}'::text[];

comment on column public.ai_flow_team_members.tags is
  'Free-text labels for what this member handles (e.g. buyer, seller). Matched '
  'case-insensitively by flow steps that target an audience. A filter matching '
  'nobody must fall back to the whole eligible audience, never to nobody.';

-- Matching is "does this member carry this tag", so the array containment
-- operator is what runs, and GIN is the index for it. Small tables today, but
-- the roster is read on every lead route.
create index if not exists ai_flow_team_members_tags_idx
  on public.ai_flow_team_members using gin (tags);

-- Data API grants: the column rides an existing table whose grants are already
-- set, and column-level grants follow the table's. Restated here so the
-- migration is self-describing rather than relying on the reader to check.
-- grants: none (ai_flow_team_members.tags): column on an existing granted
-- table; service_role and the dashboard's authenticated policies already cover
-- ai_flow_team_members, and a new column inherits them.
