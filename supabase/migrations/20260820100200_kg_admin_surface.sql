-- Knowledge-graph admin surface: fleet-default inheritance + the durable
-- retrieval-comparison ledger.
--
-- 1. memory_graph_mode gains 'inherit' (the new column default): the
--    tenant follows the platform-wide default mode, stored in the existing
--    admin_platform_settings key/value table under
--    'memory_graph_default_mode' (code default: 'shadow' — the graph builds
--    and telemetry accumulates fleet-wide with ZERO answer-path change; see
--    resolveMemoryGraphMode in src/lib/memory/graph-db.ts). Existing 'off'
--    rows migrate to 'inherit' — nobody chose off deliberately (it was the
--    pre-surface column default); explicit shadow/active overrides (HQ,
--    Amy) are preserved.
--
-- 2. kg_retrieval_events — one row per knowledge lookup on a shadow/active
--    tenant, recording the graph-vs-ranked-memory side-by-side that
--    previously lived only in ephemeral Vercel stdout logs
--    (kg_shadow_retrieval). Powers /admin/memory-graph. Content-bearing
--    (question/answer/context text), so it joins the end-user erasure
--    surface (src/lib/privacy/deletion.ts) and gets a fixed 90-day prune in
--    the daily retention sweep.
--
-- Version stamp continues the ledger sequence after 20260820100100 (see
-- 20260820100000_memory_archive.sql for the note about production's legacy
-- future-dated ledger head).
--
-- Security posture: RLS enabled with NO policies (deny-all for
-- anon/authenticated) — identical to the other service-role-only tables.

alter table public.business_configs
  drop constraint if exists business_configs_memory_graph_mode_check;

alter table public.business_configs
  add constraint business_configs_memory_graph_mode_check
  check (memory_graph_mode in ('inherit', 'off', 'shadow', 'active'));

alter table public.business_configs
  alter column memory_graph_mode set default 'inherit';

update public.business_configs
  set memory_graph_mode = 'inherit'
  where memory_graph_mode = 'off';

create table if not exists public.kg_retrieval_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Mode the lookup ran under ('shadow' answers ignored the graph;
  -- 'active' answers carried it). Recording continues after a flip so the
  -- comparison view stays populated.
  mode text not null check (mode in ('shadow', 'active')),
  question text not null,
  answer text not null,
  graph_context text not null default '',
  memory_context text not null default '',
  graph_matched_entities integer not null default 0,
  graph_facts integer not null default 0,
  graph_context_chars integer not null default 0,
  memory_context_chars integer not null default 0,
  memory_selected integer not null default 0,
  memory_from_archive integer not null default 0,
  memory_fallback boolean not null default false,
  caller_provided boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_kg_retrieval_events_business_created
  on public.kg_retrieval_events (business_id, created_at desc);

alter table public.kg_retrieval_events enable row level security;
