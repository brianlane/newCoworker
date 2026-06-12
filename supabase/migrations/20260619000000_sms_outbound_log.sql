-- AiFlow outbound SMS visibility.
--
-- The ai-flow-worker sends SMS (lead intros, team agent offers, owner
-- notifications) straight through Telnyx without writing any durable row, so
-- none of it appears in the dashboard "Text history" — that page reads only
-- sms_inbound_jobs (the inbound-conversation queue). This table is the
-- append-only log of every worker-sent message; the dashboard merges it into
-- conversation threads.
--
-- Service-role writes only (the worker and Next.js API routes both use the
-- service client); RLS is enabled with no policies so anon/authenticated
-- clients can never read another tenant's messages.

create table if not exists public.sms_outbound_log (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  to_e164 text not null,
  from_e164 text,
  body text not null,
  -- Where the send came from: an ai_flow send_sms step, a route_to_team agent
  -- offer, or an owner-facing notification (approval prompt / notify_owner /
  -- claim notice).
  source text not null check (source in ('ai_flow', 'agent_offer', 'owner_notify')),
  run_id uuid,
  flow_id uuid,
  telnyx_message_id text,
  created_at timestamptz not null default now()
);

comment on table public.sms_outbound_log is
  'Append-only log of worker-sent outbound SMS (AiFlow sends, agent offers, owner notifications). Merged into the dashboard Text history alongside sms_inbound_jobs.';

create index if not exists sms_outbound_log_business_created_idx
  on public.sms_outbound_log (business_id, created_at desc);

create index if not exists sms_outbound_log_business_to_idx
  on public.sms_outbound_log (business_id, to_e164, created_at desc);

alter table public.sms_outbound_log enable row level security;
