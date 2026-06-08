-- AiFlows: per-business trigger + action automation engine.
--
-- An "AiFlow" is an owner-authored automation: a TRIGGER (today: an inbound SMS
-- matching configured conditions, optionally correlated across the last few
-- messages from the same sender) that fires an ordered list of STEPS
-- (browse a public link + extract structured fields, send a templated SMS,
-- gate on owner approval, notify the owner, call a custom HTTP integration).
--
-- Naming: deliberately `ai_flow_*` (NOT `workflow`) because "workflow" already
-- means the Rowboat agent graph (liveWorkflow/draftWorkflow/startAgent) across
-- the VPS seed, debug scripts, and the SMS worker. Keeping a distinct prefix
-- avoids confusing engineers and grep.
--
-- Three tables:
--   ai_flows           - the definition (JSONB), one row per automation.
--   ai_flow_runs       - one execution instance; a small state machine the
--                        async ai-flow-worker drives (queued -> running ->
--                        awaiting_approval -> done|failed|canceled).
--   ai_flow_run_steps  - per-step audit trail for the dashboard run timeline
--                        and step-level idempotency.

-- ---------------------------------------------------------------------------
-- ai_flows: the authored automation definition.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_flows (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Owner-facing name (shown in the dashboard list + run history).
  name text not null check (length(trim(name)) between 1 and 120),
  -- Master on/off. A disabled flow is never evaluated by the trigger hook.
  enabled boolean not null default false,
  -- The full automation: { trigger: {...}, steps: [...], options: {...} }.
  -- Validated in app code (src/lib/ai-flows/schema.ts) before write and by the
  -- engine at run time (supabase/functions/_shared/ai_flows). Stored as JSONB
  -- rather than normalized columns because the step list is variable-shape and
  -- versions over time (mirrors onboarding_drafts.payload / integrations.metadata).
  definition jsonb not null default '{}'::jsonb,
  -- Auth user id (auth.users) that created/last edited; informational only.
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_flows_business_id_idx
  on public.ai_flows (business_id);

-- Hot path for the trigger hook: only enabled flows for a business.
create index if not exists ai_flows_business_enabled_idx
  on public.ai_flows (business_id) where enabled;

-- ---------------------------------------------------------------------------
-- ai_flow_runs: one execution of a flow.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_flow_runs (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.ai_flows(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- queued        - enqueued by the trigger hook, not yet claimed.
  -- running        - claimed by the worker, executing steps.
  -- awaiting_approval - paused at an approval_gate step; resumes on owner decision.
  -- done|failed|canceled - terminal.
  status text not null default 'queued'
    check (status in ('queued', 'running', 'awaiting_approval', 'done', 'failed', 'canceled')),
  -- Accumulated execution context: the trigger payload plus every variable a
  -- step has produced (e.g. extracted seller_phone). Templated step fields
  -- read from here ({{vars.x}} / {{trigger.x}}).
  context jsonb not null default '{}'::jsonb,
  -- Index into definition.steps of the step to run next (0-based).
  current_step int not null default 0,
  attempt_count int not null default 0,
  last_error text,
  -- Worker lease timestamp; used by the stale-reclaim RPC.
  claimed_at timestamptz,
  -- Optional caller-supplied idempotency key (e.g. telnyx_event_id) so the
  -- trigger hook never enqueues two runs for the same source event.
  dedupe_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_flow_runs_business_id_idx
  on public.ai_flow_runs (business_id, created_at desc);

create index if not exists ai_flow_runs_flow_id_idx
  on public.ai_flow_runs (flow_id, created_at desc);

-- Claim hot path: queued runs in FIFO order.
create index if not exists ai_flow_runs_claimable_idx
  on public.ai_flow_runs (created_at) where status = 'queued';

-- Exactly-once enqueue: at most one run per (flow, dedupe_key) when a key is set.
create unique index if not exists ai_flow_runs_flow_dedupe_idx
  on public.ai_flow_runs (flow_id, dedupe_key) where dedupe_key is not null;

-- ---------------------------------------------------------------------------
-- ai_flow_run_steps: per-step audit trail + step-level idempotency.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_flow_run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ai_flow_runs(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  step_index int not null,
  step_type text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed', 'skipped')),
  -- Step output (vars produced, the SMS message id, the extracted fields, ...).
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_flow_run_steps_run_id_idx
  on public.ai_flow_run_steps (run_id, step_index);

-- One row per (run, step_index): the worker upserts on this so a retried run
-- does not duplicate the timeline.
create unique index if not exists ai_flow_run_steps_run_step_idx
  on public.ai_flow_run_steps (run_id, step_index);

-- ---------------------------------------------------------------------------
-- updated_at maintenance (shared trigger function).
-- ---------------------------------------------------------------------------
create or replace function public.tg_ai_flows_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ai_flows_touch_updated_at on public.ai_flows;
create trigger ai_flows_touch_updated_at
  before update on public.ai_flows
  for each row execute function public.tg_ai_flows_touch_updated_at();

drop trigger if exists ai_flow_runs_touch_updated_at on public.ai_flow_runs;
create trigger ai_flow_runs_touch_updated_at
  before update on public.ai_flow_runs
  for each row execute function public.tg_ai_flows_touch_updated_at();

drop trigger if exists ai_flow_run_steps_touch_updated_at on public.ai_flow_run_steps;
create trigger ai_flow_run_steps_touch_updated_at
  before update on public.ai_flow_run_steps
  for each row execute function public.tg_ai_flows_touch_updated_at();

-- ---------------------------------------------------------------------------
-- claim_ai_flow_runs: atomically lease queued runs to the worker.
--
-- Mirrors claim_sms_inbound_jobs: SELECT ... FOR UPDATE SKIP LOCKED so multiple
-- concurrent worker invocations never grab the same run. Flips queued -> running,
-- stamps claimed_at, bumps attempt_count, and returns the leased rows.
-- ---------------------------------------------------------------------------
create or replace function public.claim_ai_flow_runs(p_limit int default 5)
returns setof public.ai_flow_runs
language plpgsql
as $$
begin
  return query
  with claimed as (
    select r.id
    from public.ai_flow_runs r
    where r.status = 'queued'
    order by r.created_at
    for update skip locked
    limit greatest(1, p_limit)
  )
  update public.ai_flow_runs r
  set status = 'running',
      claimed_at = now(),
      attempt_count = r.attempt_count + 1
  from claimed
  where r.id = claimed.id
  returning r.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- reclaim_stale_ai_flow_runs: recover runs whose worker died mid-execution.
-- A run stuck in 'running' past the lease window is returned to 'queued' so a
-- later worker invocation picks it back up (idempotent step upserts make this
-- safe). awaiting_approval is intentionally NOT reclaimed (it waits on a human).
-- ---------------------------------------------------------------------------
create or replace function public.reclaim_stale_ai_flow_runs(p_stale_minutes int default 15)
returns int
language plpgsql
as $$
declare
  v_count int;
begin
  update public.ai_flow_runs
  set status = 'queued', claimed_at = null
  where status = 'running'
    and claimed_at is not null
    and claimed_at < now() - make_interval(mins => greatest(1, p_stale_minutes));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS.
--
-- ai_flows: owner full CRUD (authoring), mirrors custom_integrations.
-- ai_flow_runs / ai_flow_run_steps: owner SELECT only (read-only history +
-- approvals are mediated by Next.js routes using requireOwner + the service
-- client). The worker writes via the service role.
-- ---------------------------------------------------------------------------
alter table public.ai_flows enable row level security;

drop policy if exists "Owner reads own ai_flows" on public.ai_flows;
create policy "Owner reads own ai_flows"
  on public.ai_flows for select
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

drop policy if exists "Owner inserts own ai_flows" on public.ai_flows;
create policy "Owner inserts own ai_flows"
  on public.ai_flows for insert
  with check (business_id in (select id from public.businesses where owner_email = auth.email()));

drop policy if exists "Owner updates own ai_flows" on public.ai_flows;
create policy "Owner updates own ai_flows"
  on public.ai_flows for update
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

drop policy if exists "Owner deletes own ai_flows" on public.ai_flows;
create policy "Owner deletes own ai_flows"
  on public.ai_flows for delete
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

alter table public.ai_flow_runs enable row level security;

drop policy if exists "Owner reads own ai_flow_runs" on public.ai_flow_runs;
create policy "Owner reads own ai_flow_runs"
  on public.ai_flow_runs for select
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

alter table public.ai_flow_run_steps enable row level security;

drop policy if exists "Owner reads own ai_flow_run_steps" on public.ai_flow_run_steps;
create policy "Owner reads own ai_flow_run_steps"
  on public.ai_flow_run_steps for select
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

-- ---------------------------------------------------------------------------
-- Comments.
-- ---------------------------------------------------------------------------
comment on table public.ai_flows is
  'Owner-authored automations ("AiFlows"): a trigger (inbound SMS match) + ordered action steps (browse+extract, send SMS, approval gate, notify owner, http call), stored as a JSONB definition. Distinct from the Rowboat agent graph (liveWorkflow/draftWorkflow).';
comment on column public.ai_flows.definition is
  'JSONB { trigger, steps[], options }. Validated by src/lib/ai-flows/schema.ts on write and by the engine at run time.';
comment on table public.ai_flow_runs is
  'One execution of an ai_flow. State machine driven by the ai-flow-worker edge cron: queued -> running -> awaiting_approval -> done|failed|canceled. context jsonb accumulates trigger payload + step-produced vars.';
comment on column public.ai_flow_runs.dedupe_key is
  'Optional idempotency key (e.g. telnyx_event_id) so the trigger hook enqueues at most one run per source event (unique per flow).';
comment on table public.ai_flow_run_steps is
  'Per-step audit trail for the dashboard run timeline; unique (run_id, step_index) gives step-level idempotency for retried runs.';
comment on function public.claim_ai_flow_runs is
  'Atomically lease up to p_limit queued ai_flow_runs to a worker (FOR UPDATE SKIP LOCKED), flipping queued->running and stamping claimed_at. Mirrors claim_sms_inbound_jobs.';
comment on function public.reclaim_stale_ai_flow_runs is
  'Return runs stuck in running past p_stale_minutes back to queued (worker crash recovery). Does not touch awaiting_approval.';

-- ---------------------------------------------------------------------------
-- suppress_reply on sms_inbound_jobs.
--
-- When an AiFlow with options.suppressDefaultReply matches an inbound SMS, the
-- telnyx-sms-inbound webhook still persists the job (audit trail) but flags it
-- so the sms-inbound-worker skips the normal Coworker reply — the AiFlow owns
-- the response. claim_sms_inbound_jobs returns `setof sms_inbound_jobs`, so the
-- worker receives this column automatically.
-- ---------------------------------------------------------------------------
alter table public.sms_inbound_jobs
  add column if not exists suppress_reply boolean not null default false;

comment on column public.sms_inbound_jobs.suppress_reply is
  'Set by the telnyx-sms-inbound AiFlow trigger hook when a matched flow has options.suppressDefaultReply; the sms-inbound-worker then marks the job done without sending a Coworker reply.';
