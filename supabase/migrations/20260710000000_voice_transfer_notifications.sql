-- Dedup ledger for warm-transfer SMS notifications.
--
-- Every voice warm transfer (AI coworker transfer_to_owner, AiFlow
-- live-transfer handoff chain, caller-rule blind transfer) fires an outcome SMS
-- to the recipient (and the owner when the recipient isn't the owner) from the
-- Telnyx webhook handler (telnyx-voice-call-end). Telnyx retries webhooks and
-- the same logical outcome can arrive on more than one event, so we claim a
-- per-outcome dedup key here BEFORE sending: only the first writer texts.
--
-- Keys:
--   wt:{success|failed}:{legCallControlId}   (receptionist + caller-rule legs)
--   hl:{success|failed}:{aLegCallId}         (AiFlow handoff chain)
create table if not exists public.voice_transfer_notifications (
  dedupe_key text primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  outcome text not null check (outcome in ('success', 'failed')),
  created_at timestamptz not null default now()
);

create index if not exists voice_transfer_notifications_business_idx
  on public.voice_transfer_notifications (business_id, created_at desc);

-- Service-role only: written exclusively by the edge webhook handler. RLS on
-- with NO policies blocks all anon/authenticated access (matches the
-- secret-table posture used elsewhere).
alter table public.voice_transfer_notifications enable row level security;
