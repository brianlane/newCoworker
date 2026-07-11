-- ---------------------------------------------------------------------------
-- ai_reply_reasoning: the AI's decision-engine record for each outbound reply.
--
-- The Lead Management PRD (Ch. 6) wants every AI response to be intentional:
-- what did the customer want, why did the AI answer the way it did, and was
-- a human handoff involved? The SMS reply pipeline asks the model to append a
-- structured trailer to its reply (stripped before the customer sees it —
-- see supabase/functions/_shared/reply_reasoning.ts) and persists it here so
-- the staff Task Center can show "why the AI said that" next to each lead.
--
-- Best-effort by design: a missing/malformed trailer stores nothing, and a
-- failed insert never blocks the customer reply.
--
-- Security posture: RLS on, ZERO policies (service-role only), same as
-- sms_outbound_log — reads go through the Next.js server after its own auth.
-- ---------------------------------------------------------------------------

create table if not exists public.ai_reply_reasoning (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- The lead the reply went to (E.164). Matched alias-insensitively at read
  -- time by the callers (same convention as sms_outbound_log.to_e164).
  contact_e164 text not null,
  -- Reply channel. SMS today; the check leaves room for future capture sites.
  channel text not null default 'sms'
    check (channel in ('sms', 'email', 'voice', 'webchat')),
  -- First ~300 chars of the inbound message and the outbound reply, for
  -- context in the Task Center without joining the message logs.
  inbound_preview text,
  reply_preview text,
  -- The decision-engine fields the model reported: the customer's intent
  -- (short token/phrase), the one-line rationale for THIS reply, and whether
  -- the reply hands off / escalates to a human.
  intent text not null check (length(intent) between 1 and 80),
  rationale text not null check (length(rationale) between 1 and 400),
  escalated boolean not null default false,
  -- Which model answered: 'gemini' (metered path) or 'local' (over-cap Qwen).
  model text,
  created_at timestamptz not null default now()
);

-- Task Center read path: latest reasoning per contact.
create index if not exists ai_reply_reasoning_contact_idx
  on public.ai_reply_reasoning (business_id, contact_e164, created_at desc);

-- Retention sweep + business-wide listing.
create index if not exists ai_reply_reasoning_business_created_idx
  on public.ai_reply_reasoning (business_id, created_at desc);

alter table public.ai_reply_reasoning enable row level security;

comment on table public.ai_reply_reasoning is
  'Per-reply AI decision record (intent + rationale + escalation flag), parsed from a model trailer that is stripped before the customer sees the reply. Service-role only (RLS on, no policies). Pruned by the data-retention sweep; erased per person by privacy deletion.';
comment on column public.ai_reply_reasoning.intent is
  'Short customer-intent token the model reported (e.g. wants_quote, asks_hours).';
comment on column public.ai_reply_reasoning.rationale is
  'One-line "why this reply" from the model (PRD Ch. 6 decision engine).';
comment on column public.ai_reply_reasoning.escalated is
  'True when the reply hands the conversation to a human (booking/escalation).';
