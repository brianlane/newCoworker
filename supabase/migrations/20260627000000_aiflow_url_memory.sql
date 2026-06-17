-- aiflow_url_memory: cross-run URL recall for AiFlows.
--
-- Lets one AiFlow run remember a page URL keyed by a person's phone (E.164) so a
-- LATER run triggered by the same person can recall it. The motivating case is a
-- Clever lead: the "Accept" flow opens the lead's connection page and persists
-- that URL keyed by the lead's phone; a follow-up "Group Reply" flow, fired by an
-- inbound group thread, recalls the same URL (via the group participants) to post
-- a status update — without re-deriving the link.
--
-- Written/read ONLY by the ai-flow-worker (service role). One row per
-- (business_id, memory_key); a re-accept upserts the latest URL.

create table if not exists public.aiflow_url_memory (
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Normalized E.164 phone the URL is remembered under.
  memory_key text not null check (length(memory_key) between 1 and 32),
  -- The remembered page URL (a browse_action final URL).
  url text not null check (length(url) between 1 and 4000),
  -- Provenance of the last write (informational; no FK so memory survives a
  -- flow/run delete that cascades away the originating rows).
  flow_id uuid,
  run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, memory_key)
);

-- recall_url reads the freshest match across candidate keys for a business.
create index if not exists aiflow_url_memory_business_updated_idx
  on public.aiflow_url_memory (business_id, updated_at desc);

drop trigger if exists aiflow_url_memory_touch_updated_at on public.aiflow_url_memory;
create trigger aiflow_url_memory_touch_updated_at
  before update on public.aiflow_url_memory
  for each row execute function public.tg_ai_flows_touch_updated_at();

-- RLS: no client access. The worker uses the service role (bypasses RLS); the
-- owner SELECT policy mirrors ai_flow_runs so the data is debuggable via the
-- authenticated client without exposing writes.
alter table public.aiflow_url_memory enable row level security;

drop policy if exists "Owner reads own aiflow_url_memory" on public.aiflow_url_memory;
create policy "Owner reads own aiflow_url_memory"
  on public.aiflow_url_memory for select
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

comment on table public.aiflow_url_memory is
  'Cross-run URL recall for AiFlows: a browse_action persists its final URL keyed by a person''s E.164 phone (rememberUrlKeyedByVar); a later run recalls it (recall_url step). Written/read by the ai-flow-worker service role only.';
comment on column public.aiflow_url_memory.memory_key is
  'Normalized E.164 phone the URL is remembered under (unique per business).';
