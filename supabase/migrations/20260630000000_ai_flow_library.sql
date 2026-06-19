-- Public AiFlow library: a cross-tenant catalog of successful automations.
--
-- Once a flow has run successfully (>= 1 `done` run), a PII-scrubbed copy of its
-- definition is published here so any signed-in user can browse popular flows
-- and duplicate one into their own business. Entries are GROUPED by a template
-- key (the same template seeded across many tenants collapses into one entry),
-- ranked by total successful runs across all businesses, and annotated with
-- adoption / download / velocity stats.
--
-- Privacy: this table only ever stores SCRUBBED definitions (literal phones,
-- emails, names, and tenant mailbox ids replaced with neutral placeholders by
-- src/lib/ai-flows/scrub.ts). Raw definitions never leave the owning tenant.
-- The catalog is read-only to users (RLS select-only); the hourly refresh job
-- and the duplicate route write via the service role.

-- ---------------------------------------------------------------------------
-- ai_flow_library: one row per published template.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_flow_library (
  id uuid primary key default gen_random_uuid(),
  -- Grouping key (slug of the normalized flow name); one entry per template.
  template_key text not null unique,
  title text not null,
  summary text not null default '',
  -- Coarse bucket for filtering (derived from the publishing business type).
  category text,
  -- PII-scrubbed definition (display + substitution source). NOT guaranteed to
  -- be schema-valid as-is: placeholder tokens resolve when a user duplicates it.
  scrubbed_definition jsonb not null,
  -- Headline stats (recomputed each refresh; aggregated across all copies).
  total_successful_runs int not null default 0,
  total_runs int not null default 0,
  businesses_using int not null default 0,
  runs_last_7d int not null default 0,
  -- Bumped immediately on each duplicate; reconciled from the downloads table.
  download_count int not null default 0,
  last_run_at timestamptz,
  -- Extensible bag for any future stat without a schema change.
  stats jsonb not null default '{}'::jsonb,
  first_published_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ranking hot path: most popular first.
create index if not exists ai_flow_library_popular_idx
  on public.ai_flow_library (total_successful_runs desc);

create index if not exists ai_flow_library_category_idx
  on public.ai_flow_library (category);

-- ---------------------------------------------------------------------------
-- ai_flow_library_downloads: audit trail of duplications (download velocity).
-- ---------------------------------------------------------------------------
create table if not exists public.ai_flow_library_downloads (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references public.ai_flow_library(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists ai_flow_library_downloads_library_idx
  on public.ai_flow_library_downloads (library_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance (reuse the shared ai_flows touch function).
-- ---------------------------------------------------------------------------
drop trigger if exists ai_flow_library_touch_updated_at on public.ai_flow_library;
create trigger ai_flow_library_touch_updated_at
  before update on public.ai_flow_library
  for each row execute function public.tg_ai_flows_touch_updated_at();

-- ---------------------------------------------------------------------------
-- aggregate_ai_flow_library_candidates: per-flow run stats for the refresh job.
--
-- Returns ONE ROW PER FLOW that has at least one successful (`done`) run, with
-- its definition + the publishing business type and run aggregates. All
-- grouping (by template key), PII scrubbing, and stat-summing happen in TS
-- (src/lib/ai-flows/library-refresh.ts) so the slug/scrub logic stays in one
-- place under the coverage gate. Called only via the service role.
-- ---------------------------------------------------------------------------
create or replace function public.aggregate_ai_flow_library_candidates()
returns table (
  flow_id uuid,
  business_id uuid,
  name text,
  definition jsonb,
  business_type text,
  done_count bigint,
  total_count bigint,
  done_last_7d bigint,
  last_done_at timestamptz
)
language sql
stable
set search_path = pg_catalog, public
as $$
  select
    f.id as flow_id,
    f.business_id,
    f.name,
    f.definition,
    b.business_type,
    count(r.*) filter (where r.status = 'done') as done_count,
    count(r.*) as total_count,
    count(r.*) filter (
      where r.status = 'done' and r.created_at > now() - interval '7 days'
    ) as done_last_7d,
    max(r.created_at) filter (where r.status = 'done') as last_done_at
  from public.ai_flows f
  join public.businesses b on b.id = f.business_id
  join public.ai_flow_runs r on r.flow_id = f.id
  group by f.id, f.business_id, f.name, f.definition, b.business_type
  having count(r.*) filter (where r.status = 'done') >= 1;
$$;

-- Deny-by-default: revoke from everyone, grant only to service_role (the
-- fn_grants_lockdown event trigger also enforces this; explicit here too).
revoke execute on function public.aggregate_ai_flow_library_candidates() from public, anon, authenticated;
grant execute on function public.aggregate_ai_flow_library_candidates() to service_role;

-- ---------------------------------------------------------------------------
-- RLS.
--   ai_flow_library            - signed-in users SELECT the (scrubbed) catalog;
--                                writes are service-role-only (no write policy).
--   ai_flow_library_downloads  - service-role-only (RLS on, no policies).
-- ---------------------------------------------------------------------------
alter table public.ai_flow_library enable row level security;

drop policy if exists "Signed-in users read the AiFlow library" on public.ai_flow_library;
create policy "Signed-in users read the AiFlow library"
  on public.ai_flow_library for select
  to authenticated
  using (true);

alter table public.ai_flow_library_downloads enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated have no access.

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------
comment on table public.ai_flow_library is
  'Public cross-tenant catalog of successful AiFlows. Stores only PII-scrubbed definitions (src/lib/ai-flows/scrub.ts); grouped by template_key and ranked by total successful runs. Read-only to users (RLS select); written by the refresh job + duplicate route via service role.';
comment on column public.ai_flow_library.scrubbed_definition is
  'PII-scrubbed definition with placeholder tokens ({{owner_phone}}, {{owner_email}}, {{employee_name}}). Resolved to the duplicating business on use; never the raw tenant definition.';
comment on table public.ai_flow_library_downloads is
  'One row per duplication of a library entry into a business (download velocity + adoption). Service-role-only.';
comment on function public.aggregate_ai_flow_library_candidates is
  'Per-flow run aggregates for flows with >=1 successful run, for the library refresh job. Grouping/scrubbing happen in TS. service_role-only.';
