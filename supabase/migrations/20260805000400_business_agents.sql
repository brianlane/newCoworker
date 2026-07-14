-- Agents: reusable attachment→output task templates.
--
-- An agent is a saved instruction set ("take this intake form and produce a
-- cleaned-up client summary") the owner runs repeatedly against different
-- attachments (fresh uploads or existing business documents). Each run
-- executes one Gemini transformation and lands as an `agent_runs` row with
-- the produced artifact. Structurally mirrors AiFlows (definition + run
-- history binding a new input each run) but the trigger is manual +
-- interactive, so runs execute inline in the dashboard API, not through the
-- event-driven flow worker. A later `run_agent` AiFlow step will reuse the
-- same tables with source='flow'.
--
-- Security posture: RLS on with NO policies on both tables — service-role
-- only, identical to business_documents / vps_ssh_keys. Every access goes
-- through the Next.js server (owner-authenticated dashboard routes) after
-- its own auth checks.

create table if not exists business_agents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  -- The reusable prompt: what to do with each attachment.
  instructions text not null,
  -- 'markdown': the artifact is always markdown. 'same_as_input': text
  -- inputs (txt/csv/md) produce the same format back; PDFs still produce
  -- markdown (regenerating PDFs is out of scope for v1).
  output_format text not null default 'markdown'
    check (output_format in ('markdown', 'same_as_input')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_business_agents_business
  on business_agents (business_id, created_at desc);

alter table business_agents enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated denied by design.

create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references business_agents(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed')),
  -- 'manual': owner ran it from the dashboard. 'flow': a run_agent AiFlow
  -- step invoked it (ships later; the column exists so run history is
  -- uniform from day one).
  source text not null default 'manual'
    check (source in ('manual', 'flow')),
  flow_run_id uuid,
  -- Input binding: exactly one of an existing business document or a fresh
  -- upload (stored in the private business-docs bucket under
  -- `<businessId>/agent-inputs/<runId>/<filename>`). Document deletions
  -- keep the run row (history) but null the reference.
  input_document_id uuid references business_documents(id) on delete set null,
  input_filename text not null default '',
  input_mime_type text not null default '',
  input_storage_path text,
  -- The produced artifact. output_md is the canonical text (markdown or
  -- same-format text per the agent's output_format); filename/mime describe
  -- the download representation.
  output_md text not null default '',
  output_filename text not null default '',
  output_mime_type text not null default '',
  error_detail text,
  prompt_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_agent_runs_agent
  on agent_runs (agent_id, created_at desc);

create index if not exists idx_agent_runs_business
  on agent_runs (business_id, created_at desc);

alter table agent_runs enable row level security;
-- No policies: service_role only, same posture as business_agents.
