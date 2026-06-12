-- Email visibility for the dashboard "Emails" page.
--
-- Emails the coworker sends (AiFlow send_email steps via Resend or the
-- owner's connected mailbox) and the inbound emails that trigger flows have
-- no owner-facing record — they only exist in ai_flow_run_steps results and
-- system_logs. This append-only log gives the dashboard an Emails page like
-- Texts/Calls.
--
-- Service-role writes only (ai-flow-worker + Next.js service client); RLS
-- enabled with no policies so anon/authenticated clients can never read
-- another tenant's mail.

create table if not exists public.email_log (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  direction text not null check (direction in ('outbound', 'inbound')),
  to_email text,
  from_email text,
  subject text,
  -- First ~500 chars of the body; full bodies live with the provider.
  body_preview text,
  -- ai_flow: platform (Resend) send from a flow; owner_mailbox: sent as the
  -- owner via their connected Gmail/Outlook; email_trigger: inbound email
  -- that triggered a flow run.
  source text not null check (source in ('ai_flow', 'owner_mailbox', 'email_trigger')),
  run_id uuid,
  flow_id uuid,
  provider_message_id text,
  created_at timestamptz not null default now()
);

comment on table public.email_log is
  'Append-only log of coworker email activity (AiFlow sends, owner-mailbox sends, flow-triggering inbound emails). Read by the dashboard Emails page.';

create index if not exists email_log_business_created_idx
  on public.email_log (business_id, created_at desc);

alter table public.email_log enable row level security;
