-- voice_caller_transfer_rules: per-caller warm-transfer rules for inbound voice.
--
-- Some inbound numbers should bypass the AI voice bridge entirely and connect
-- straight to a human. The motivating case is Clever's live-transfer line
-- (833-225-3837): when it calls, we answer, optionally play a brief whisper to
-- the caller, and immediately transfer the call to the assigned agent (Dave),
-- with no AI conversation and without reserving/billing voice minutes.
--
-- Read by telnyx-voice-inbound (service role) on every call.initiated, keyed by
-- (business_id, from_e164). One row per inbound caller per business.

create table if not exists public.voice_caller_transfer_rules (
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Inbound caller (E.164) this rule matches.
  from_e164 text not null check (from_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- Destination (E.164) to warm-transfer the call to.
  to_e164 text not null check (to_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- Optional short greeting spoken to the caller before the bridge. NULL = none.
  whisper text check (whisper is null or length(whisper) between 1 and 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, from_e164)
);

drop trigger if exists voice_caller_transfer_rules_touch_updated_at
  on public.voice_caller_transfer_rules;
create trigger voice_caller_transfer_rules_touch_updated_at
  before update on public.voice_caller_transfer_rules
  for each row execute function public.tg_ai_flows_touch_updated_at();

-- RLS: no client writes. The voice handler uses the service role (bypasses RLS);
-- the owner SELECT policy keeps the rules debuggable via the authenticated client.
alter table public.voice_caller_transfer_rules enable row level security;

drop policy if exists "Owner reads own voice_caller_transfer_rules"
  on public.voice_caller_transfer_rules;
create policy "Owner reads own voice_caller_transfer_rules"
  on public.voice_caller_transfer_rules for select
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

comment on table public.voice_caller_transfer_rules is
  'Per-caller warm-transfer rules for inbound voice: when from_e164 calls, telnyx-voice-inbound bridges straight to to_e164 (optional whisper) with no AI and no minute billing. Read by the voice handler service role.';
comment on column public.voice_caller_transfer_rules.whisper is
  'Optional short greeting spoken to the caller before the transfer; NULL plays nothing.';
