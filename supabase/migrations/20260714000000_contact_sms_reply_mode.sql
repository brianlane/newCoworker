-- ---------------------------------------------------------------------------
-- Per-contact SMS reply mode + owner "what would you like me to say?" prompts.
--
-- Motivating incident (2026-07-01): a dead-letter requeue replayed messages
-- from two lead-source auto-responder numbers (Clever's queue bot and
-- realtor.com's notification number). The Coworker replied, the bots
-- auto-replied, and the exchange ping-ponged ~100 messages in 15 minutes.
-- The emergency stop was `sms_opt_outs` — but that gate runs BEFORE AiFlow
-- trigger evaluation in telnyx-sms-inbound, so it also silenced the Clever /
-- realtor.com lead automations. This adds the correct owner-facing control:
--
--   contacts.sms_reply_mode
--     'auto'          — default; the Coworker replies as today.
--     'suppress'      — NO default Coworker reply. The inbound is still
--                       logged, still bumps interaction counters, and still
--                       triggers AiFlows (their suppressDefaultReply /
--                       send_sms behavior is unchanged). Manual sends from
--                       the dashboard thread are unaffected.
--     'forward_owner' — like 'suppress', but the text is forwarded to the
--                       owner's cell with "What would you like me to say?".
--                       The owner's next reply back to the business number is
--                       sent to the customer verbatim (see prompts table).
--
-- The gate is enforced in sms-inbound-worker AFTER the AiFlow suppress_reply
-- branch, so an AiFlow that owns the reply behaves exactly as before.
-- ---------------------------------------------------------------------------

alter table public.contacts
  add column if not exists sms_reply_mode text not null default 'auto';

alter table public.contacts
  drop constraint if exists contacts_sms_reply_mode_chk;
alter table public.contacts
  add constraint contacts_sms_reply_mode_chk
  check (sms_reply_mode in ('auto', 'suppress', 'forward_owner'));

comment on column public.contacts.sms_reply_mode is
  'Owner-set default-reply behavior for this contact''s inbound SMS: auto (Coworker replies), suppress (no default reply; AiFlows + manual sends unaffected), forward_owner (no default reply; forward to owner cell asking what to send, owner''s reply is relayed).';

-- One row per forwarded "what would you like me to say?" prompt. The webhook
-- resolves the OWNER's next inbound text against the newest unanswered row
-- (bounded by a freshness window app-side) and relays it to customer_e164.
create table if not exists public.sms_owner_reply_prompts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_e164 text not null,
  -- The inbound job that triggered the forward; unique so a worker retry of
  -- the same job can never stack duplicate prompts.
  inbound_job_id uuid references public.sms_inbound_jobs(id) on delete set null,
  inbound_text text not null default '',
  answered_at timestamptz,
  -- The owner's relayed reply (for audit; the thread render reads
  -- sms_outbound_log like every other manual send).
  reply_body text,
  reply_telnyx_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_sms_owner_reply_prompts_job
  on public.sms_owner_reply_prompts (inbound_job_id)
  where inbound_job_id is not null;

-- "Newest unanswered prompt for a business" is the hot lookup on every owner
-- inbound text.
create index if not exists idx_sms_owner_reply_prompts_pending
  on public.sms_owner_reply_prompts (business_id, created_at desc)
  where answered_at is null;

alter table public.sms_owner_reply_prompts enable row level security;

drop policy if exists "Service role manages sms_owner_reply_prompts"
  on public.sms_owner_reply_prompts;
create policy "Service role manages sms_owner_reply_prompts"
  on public.sms_owner_reply_prompts for all
  using (auth.role() = 'service_role');

comment on table public.sms_owner_reply_prompts is
  'Pending/answered "what would you like me to say?" forwards for contacts with sms_reply_mode=forward_owner. Written by sms-inbound-worker when it forwards a customer text to the owner; resolved by telnyx-sms-inbound when the owner texts back (newest unanswered wins, freshness-bounded app-side).';
