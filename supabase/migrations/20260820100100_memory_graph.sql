-- Per-tenant memory knowledge graph (source of truth: central Postgres).
--
-- Owner-memory capture historically appended flat bullet lines to
-- business_configs.memory_md — no entity model, so "Amy Laidlaw
-- 602-695-1142" and "escalate urgent to Amy at 602 695 1142" persisted as
-- unrelated facts, and a changed value never superseded the old one. These
-- two tables give captured knowledge structure:
--
--   memory_entities — one canonical node per person/org/service/policy the
--     owner has told the coworker about. Aliases + normalized phones/emails
--     drive deterministic entity resolution on the write path
--     (src/lib/memory/graph-write.ts). `customer_e164` links a person node
--     to the existing customer_memories row where the numbers match.
--   memory_facts — subject–predicate–object triples. `object_entity_id` for
--     entity↔entity edges, `object_value` for literals. A new value for the
--     same (subject, predicate) SUPERSEDES the old fact (active=false +
--     superseded_by) instead of accumulating a contradiction.
--
-- business_configs.memory_graph_mode drives the rollout per tenant:
--   off    (default) — no graph writes, no behavior change anywhere.
--   shadow — graph is WRITTEN on capture and retrieval is computed + logged,
--            but live answers still come from the ranked-markdown path.
--   active — graph retrieval feeds the knowledge-lookup prompt.
--
-- Version stamp continues the ledger sequence after 20260820100000 (see
-- that file's note about production's legacy future-dated ledger head).
--
-- Security posture: RLS enabled with NO policies (deny-all for
-- anon/authenticated) — identical to the other service-role-only tables.
-- Every access goes through the Next.js server after its own auth checks.

create table if not exists public.memory_entities (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  kind text not null check (kind in ('person', 'organization', 'service', 'policy', 'place', 'other')),
  canonical_name text not null,
  -- Lowercased alternate names ("amy", "amy laidlaw"). jsonb array of strings.
  aliases jsonb not null default '[]'::jsonb,
  -- Normalized phone digits (last 10) for deterministic resolution.
  phones jsonb not null default '[]'::jsonb,
  -- Lowercased email addresses for deterministic resolution.
  emails jsonb not null default '[]'::jsonb,
  -- E.164 link into customer_memories when a person node matches a known
  -- customer of this business (nullable — most entities are not customers).
  customer_e164 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_memory_entities_business
  on public.memory_entities (business_id);

alter table public.memory_entities enable row level security;

create table if not exists public.memory_facts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  subject_entity_id uuid not null references public.memory_entities(id) on delete cascade,
  -- Snake_case relation name ("phone", "role", "escalation_target", ...).
  predicate text not null,
  -- Exactly one of object_entity_id / object_value is set (enforced below).
  object_entity_id uuid references public.memory_entities(id) on delete cascade,
  object_value text,
  -- The owner's bullet this fact was extracted from (provenance/audit).
  source_text text not null,
  stated_at timestamptz not null default now(),
  active boolean not null default true,
  superseded_by uuid references public.memory_facts(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint memory_facts_object_one_of check (
    (object_entity_id is not null and object_value is null)
    or (object_entity_id is null and object_value is not null)
  )
);

create index if not exists idx_memory_facts_business_subject
  on public.memory_facts (business_id, subject_entity_id);

alter table public.memory_facts enable row level security;

alter table public.business_configs
  add column if not exists memory_graph_mode text not null default 'off';

alter table public.business_configs
  drop constraint if exists business_configs_memory_graph_mode_check;

alter table public.business_configs
  add constraint business_configs_memory_graph_mode_check
  check (memory_graph_mode in ('off', 'shadow', 'active'));
