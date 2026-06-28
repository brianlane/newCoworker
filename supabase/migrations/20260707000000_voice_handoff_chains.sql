-- voice_handoff_chains + voice_handoff_sessions: sequential warm-handoff chains
-- for inbound voice (HomeLight live transfer).
--
-- voice_caller_transfer_rules handles a single blind transfer. The HomeLight
-- live-transfer line needs more: ring Dave, and if he doesn't pick up ring Amy,
-- and if neither answers let the AI worker take the call, press "1" so HomeLight
-- connects the live client, capture the lead, and text Amy a summary + transcript.
--
-- A chain row is the ordered plan (which humans to try, for how long, plus an
-- optional AI takeover). A session row is the per-call running state, keyed by
-- the inbound (A-leg) call_control_id so the webhook can advance the chain
-- across Telnyx call-control events (call.bridged / call.hangup).
--
-- Read/written by telnyx-voice-inbound (service role) and read by the VPS voice
-- bridge (service role) to switch into HomeLight intake mode.

-- ---------------------------------------------------------------------------
-- 1. voice_handoff_chains: the ordered plan per (business, inbound caller).
-- ---------------------------------------------------------------------------
create table if not exists public.voice_handoff_chains (
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Inbound caller (E.164) this chain matches (e.g. the HomeLight live-transfer line).
  from_e164 text not null check (from_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- Ordered human handoff steps: [{ "to_e164": "+1...", "ring_secs": 20 }, ...].
  -- Each step is rung in order; on no-answer we advance to the next.
  steps jsonb not null default '[]'::jsonb
    check (jsonb_typeof(steps) = 'array'),
  -- Optional AI takeover when every human step is missed:
  --   { "notify_e164": "+1...", "persona": "...", "capture_fields": ["name", ...] }
  -- NULL = no AI fallback (just exhaust the human steps and hang up).
  ai_takeover jsonb
    check (ai_takeover is null or jsonb_typeof(ai_takeover) = 'object'),
  -- Off by default so a freshly seeded chain never goes live before a manual
  -- test confirms the Telnyx transfer no-answer semantics on this account.
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, from_e164)
);

drop trigger if exists voice_handoff_chains_touch_updated_at
  on public.voice_handoff_chains;
create trigger voice_handoff_chains_touch_updated_at
  before update on public.voice_handoff_chains
  for each row execute function public.tg_ai_flows_touch_updated_at();

alter table public.voice_handoff_chains enable row level security;

drop policy if exists "Owner reads own voice_handoff_chains"
  on public.voice_handoff_chains;
create policy "Owner reads own voice_handoff_chains"
  on public.voice_handoff_chains for select
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

comment on table public.voice_handoff_chains is
  'Ordered warm-handoff chains for inbound voice: ring each step.to_e164 in order, then optionally hand to the AI worker (ai_takeover). Read by telnyx-voice-inbound (service role). Disabled by default.';
comment on column public.voice_handoff_chains.steps is
  'Ordered human handoff steps as a JSON array of { to_e164, ring_secs }.';
comment on column public.voice_handoff_chains.ai_takeover is
  'Optional AI takeover config { notify_e164, persona, capture_fields }; NULL disables AI fallback.';
comment on column public.voice_handoff_chains.enabled is
  'When false the chain is ignored by the voice handler (safe default until a live test).';

-- ---------------------------------------------------------------------------
-- 2. voice_handoff_sessions: per-call running state, keyed by A-leg call id.
-- ---------------------------------------------------------------------------
create table if not exists public.voice_handoff_sessions (
  -- Inbound (A-leg) Telnyx call_control_id. One session per inbound call.
  call_control_id text primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- The inbound caller (A-leg ANI) and the chain key it matched (usually equal).
  from_e164 text not null,
  chain_from_e164 text not null,
  -- ringing  : currently ringing a human step
  -- bridged  : a human answered; chain is done, no further advancement
  -- ai_intake: both/all humans missed; AI worker is handling the live client
  -- done     : terminal (call ended)
  status text not null default 'ringing'
    check (status in ('ringing', 'bridged', 'ai_intake', 'done')),
  -- Index into voice_handoff_chains.steps of the step currently being tried.
  current_step int not null default 0,
  -- Scratch context: { notify_e164, ai_takeover, last_step_to_e164, ... }.
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists voice_handoff_sessions_business_idx
  on public.voice_handoff_sessions (business_id, created_at desc);

drop trigger if exists voice_handoff_sessions_touch_updated_at
  on public.voice_handoff_sessions;
create trigger voice_handoff_sessions_touch_updated_at
  before update on public.voice_handoff_sessions
  for each row execute function public.tg_ai_flows_touch_updated_at();

alter table public.voice_handoff_sessions enable row level security;

drop policy if exists "Owner reads own voice_handoff_sessions"
  on public.voice_handoff_sessions;
create policy "Owner reads own voice_handoff_sessions"
  on public.voice_handoff_sessions for select
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

comment on table public.voice_handoff_sessions is
  'Per-call running state for voice_handoff_chains, keyed by the inbound A-leg call_control_id; lets telnyx-voice-inbound advance the chain across Telnyx call-control webhooks and lets the VPS bridge detect HomeLight intake mode. Service-role writes only.';
