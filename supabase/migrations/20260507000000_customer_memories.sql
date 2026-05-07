-- Cross-channel customer memory rollup (Phase 2 of the SMS/Voice/Dashboard
-- unification plan).
--
-- Closes "sharp edge #2/3" from the architecture review: SMS and voice
-- previously had no shared per-customer state, and there was no
-- CRM-style profile lookup keyed by E.164 for inbound calls. This
-- table is the canonical per-(business_id, customer_e164) memory:
-- one row per known customer, with a rolling LLM-generated summary
-- regenerated post-interaction (gated) and nightly via a low-priority
-- batch sweep.
--
-- Read side (Phase 3): SMS worker + voice bridge prepend
-- summary_md + pinned_md as a system message before the user turn so
-- both channels see the same per-customer context.
--
-- Write side: incrementInteraction() bumps counters on every
-- inbound; the gate fires summarizeCustomerMemory() fire-and-forget
-- when (interactions_since_summary >= 3 AND last_summarized_at older
-- than 30s) so we don't preempt live calls/texts. The nightly cron
-- (Phase 2 cron schedule) picks up everyone whose counter exceeded
-- the threshold but never crossed the debounce window.
--
-- Cascade: when a business is deleted, its customer memories go with
-- it. Per-row deletion is exposed via the customers page in the UI
-- (Phase 4), and that path goes through the service role using a
-- thin RLS-gated owner check in application code (mirrors how
-- dashboard chat threads work — see RLS block below).

create table if not exists public.customer_memories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- E.164 of the *customer* (not the business). Pair (business_id,
  -- customer_e164) is unique because a single customer is one
  -- continuous identity across all channels for a given business.
  customer_e164 text not null,
  -- Best-known display name. Populated by:
  --   1. Phase 5 voice tool call (customer self-identifies on a call)
  --   2. Owner edit from the customers page
  --   3. Optional: auto-extract from summary_md (left for future)
  -- Nullable: anonymous customers exist (cold inbound, missed call).
  display_name text,
  -- LLM-generated rolling summary covering known facts about this
  -- customer + the most recent N interactions. Hard-capped client-side
  -- (~2000 chars) so a runaway model can't dominate the prompt budget
  -- on every subsequent SMS/voice turn. NULL = no summary yet (first
  -- interaction; the caller renders nothing rather than an empty
  -- "Customer summary:" header).
  summary_md text,
  -- Owner-managed pinned notes. These survive every summarizer
  -- regeneration and are concatenated to the preamble alongside
  -- summary_md. Use for stable facts the owner wants the AI to ALWAYS
  -- carry into a conversation ("repeat buyer", "do not upsell",
  -- "always greet by Mr."). Settable from the customers page (Phase
  -- 4) and via the customer_memory_write tool (Phase 5).
  pinned_md text,
  -- Counters that drive the gate decision. interaction_count is the
  -- number of distinct interactions since the last successful
  -- summarizer run (reset to 0 when summary_md is regenerated);
  -- total_interaction_count is the lifetime counter (purely
  -- informational for the customers page UI).
  interaction_count integer not null default 0,
  total_interaction_count integer not null default 0,
  last_interaction_at timestamptz,
  last_summarized_at timestamptz,
  -- Channel of the most recent interaction. Surfaced on the customers
  -- page so the owner can see "last contacted via SMS 3h ago" without
  -- a join. Constrained to known channels so a typo doesn't poison
  -- the UI.
  last_channel text check (last_channel in ('sms', 'voice', 'dashboard')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, customer_e164)
);

-- Cheap "list customers for this business by recency" — drives the
-- customers page (Phase 4). Includes the descending order so the
-- planner can use it for the LIMIT'd page query without a sort.
create index if not exists idx_customer_memories_business_recent
  on public.customer_memories (business_id, last_interaction_at desc);

-- Used by the post-interaction gate: "find rows over the threshold
-- but past the debounce". Partial index keeps the size proportional
-- to the working set (only customers needing summarization), not the
-- total customer base.
create index if not exists idx_customer_memories_summary_due
  on public.customer_memories (business_id, last_summarized_at)
  where interaction_count >= 3;

-- updated_at maintenance — same trigger pattern other tables use.
create or replace function public.set_customer_memories_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_customer_memories_set_updated_at on public.customer_memories;
create trigger trg_customer_memories_set_updated_at
  before update on public.customer_memories
  for each row
  execute function public.set_customer_memories_updated_at();

alter table public.customer_memories enable row level security;

-- Service role does every write (worker, bridge, summarizer, nightly
-- cron). The customers page reads/updates/deletes via Next.js API
-- routes that call requireOwner() first — not via direct RLS — so
-- there's no owner SELECT/UPDATE/DELETE policy here. That mirrors
-- the dashboard_chat_threads RLS shape: API-side ownership check is
-- the source of truth, RLS is the defense-in-depth fallback.
drop policy if exists "Service role manages customer_memories"
  on public.customer_memories;
create policy "Service role manages customer_memories"
  on public.customer_memories for all
  using (auth.role() = 'service_role');

comment on table public.customer_memories is
  'Per-(business, customer_e164) cross-channel memory: rolling LLM summary + owner-pinned notes. Read by SMS worker + voice bridge to inject a system preamble; written post-interaction (gated) and nightly. Cascades from businesses(id).';

comment on column public.customer_memories.summary_md is
  'LLM-generated summary, regenerated when interaction_count >= 3 (gated by 30s debounce on last_summarized_at). Capped at ~2000 chars in application code.';

comment on column public.customer_memories.pinned_md is
  'Owner-controlled persistent notes. Concatenated with summary_md in the preamble; survives every summarizer regeneration.';

comment on column public.customer_memories.interaction_count is
  'Interactions since last successful summarizer run; reset to 0 by the summarizer. Drives the >=3 threshold gate.';

-- Denormalized customer E.164 on inbound jobs so the customers page
-- (Phase 4) and SMS history feeder (Phase 3 input source) can query
-- per-customer SMS without parsing the JSONB payload at scan time.
-- Backfill: nullable for now; worker writes it on next claim from
-- the same normalizeE164() value it already computes for routing.
-- A historical backfill would require running normalizeE164 in SQL
-- — deliberately deferred so we don't ship the migration with a
-- 200ms-per-row UDF that blocks deploy on a large table.
alter table public.sms_inbound_jobs
  add column if not exists customer_e164 text;

create index if not exists idx_sms_inbound_jobs_customer
  on public.sms_inbound_jobs (business_id, customer_e164, created_at desc)
  where customer_e164 is not null;

comment on column public.sms_inbound_jobs.customer_e164 is
  'Normalized E.164 of the inbound sender, denormalized from payload at job-claim time so per-customer SMS history is queryable without JSONB scans. Nullable for legacy rows pre-Phase-2 migration.';

-- Atomic interaction recorder: insert-or-bump in a single round trip.
-- Hot inbound path runs this on every SMS / voice call / dashboard
-- chat turn that names a customer; doing two queries (read + write)
-- would double the Vercel→Supabase RTT cost on every interaction.
--
-- Returns the post-update row so the caller can branch on
-- `interaction_count >= 3` to decide whether to fire the summarizer
-- without an extra read.
--
-- Why the display_name only-write-if-currently-null pattern: voice
-- and SMS callers don't always know a name (anonymous SMS in,
-- inbound call from unknown). Phase 5 voice tools and the customers
-- page UI explicitly set the name; we don't want a later anonymous
-- interaction to clobber a name the owner already chose.
create or replace function public.record_customer_interaction(
  p_business_id uuid,
  p_customer_e164 text,
  p_channel text,
  p_display_name text default null
)
returns public.customer_memories
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result public.customer_memories;
begin
  if p_channel not in ('sms', 'voice', 'dashboard') then
    raise exception 'record_customer_interaction: invalid channel %', p_channel;
  end if;

  insert into public.customer_memories (
    business_id, customer_e164, display_name,
    interaction_count, total_interaction_count,
    last_interaction_at, last_channel
  ) values (
    p_business_id, p_customer_e164, p_display_name,
    1, 1,
    now(), p_channel
  )
  on conflict (business_id, customer_e164) do update
    set interaction_count = customer_memories.interaction_count + 1,
        total_interaction_count = customer_memories.total_interaction_count + 1,
        last_interaction_at = now(),
        last_channel = excluded.last_channel,
        display_name = coalesce(customer_memories.display_name, excluded.display_name),
        updated_at = now()
  returning * into result;

  return result;
end;
$$;

revoke all on function public.record_customer_interaction(uuid, text, text, text) from public;
grant execute on function public.record_customer_interaction(uuid, text, text, text)
  to service_role;
