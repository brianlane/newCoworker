-- voice_expected_transfers: short-lived "expect a live-transfer call" windows.
--
-- Motivating case: Clever's Cue text ("Reply Y - ready for a call") is answered
-- by an AiFlow, after which a Clever Concierge calls the business DID from a
-- ROTATING pool of numbers that per-caller routing (voice AiFlows /
-- voice_caller_transfer_rules) can never enumerate. The arm_voice_transfer
-- AiFlow step upserts a row here; while the row is unexpired and unconsumed,
-- telnyx-voice-inbound bridges any inbound call that matched NO other voice
-- routing straight to to_e164 (no AI conversation), then stamps consumed_at so
-- one armed window transfers exactly one call.
--
-- One ACTIVE window per business: the arming step upserts on business_id,
-- extending expires_at and resetting consumption.

create table if not exists public.voice_expected_transfers (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  -- Destination (E.164) to warm-transfer the expected call to.
  to_e164 text not null check (to_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- Optional short greeting spoken to the caller before the bridge. NULL = none.
  whisper text check (whisper is null or length(whisper) between 1 and 300),
  -- The window: calls arriving after this instant fall through to normal routing.
  expires_at timestamptz not null,
  -- The AiFlow whose arm_voice_transfer step armed this window (debuggability).
  armed_by_flow_id uuid references public.ai_flows(id) on delete set null,
  -- Set when a call consumed the window (one transfer per arming).
  consumed_at timestamptz,
  consumed_call_control_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists voice_expected_transfers_touch_updated_at
  on public.voice_expected_transfers;
create trigger voice_expected_transfers_touch_updated_at
  before update on public.voice_expected_transfers
  for each row execute function public.tg_ai_flows_touch_updated_at();

-- RLS: no client writes. The voice handler + ai-flow-worker use the service
-- role (bypasses RLS); the owner SELECT policy keeps windows debuggable via
-- the authenticated client — same posture as voice_caller_transfer_rules.
alter table public.voice_expected_transfers enable row level security;

drop policy if exists "Owner reads own voice_expected_transfers"
  on public.voice_expected_transfers;
create policy "Owner reads own voice_expected_transfers"
  on public.voice_expected_transfers for select
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

comment on table public.voice_expected_transfers is
  'Short-lived armed transfer windows: while unexpired and unconsumed, telnyx-voice-inbound bridges any inbound call that matched no other voice routing straight to to_e164 (no AI), then stamps consumed_at. Armed by the arm_voice_transfer AiFlow step (service role).';
comment on column public.voice_expected_transfers.expires_at is
  'End of the armed window; calls arriving after this fall through to the normal AI path.';
comment on column public.voice_expected_transfers.consumed_at is
  'Set when a call consumed the window — one armed window transfers exactly one call.';
