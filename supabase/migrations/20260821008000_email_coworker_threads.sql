-- Email coworker: the threads it owns, and the messages it has evaluated.
--
-- Inbound email previously reached AI only as an AiFlow TRIGGER: there was
-- no conversational turn with calendar tools, so a delegate's reply ("Liz
-- has availability Monday at 12 PM EST, send the Zoom invite") died in the
-- owner's inbox. This is the state behind the surface that answers those.
--
-- SAFETY MODEL, the reason this table exists: the coworker replies ONLY
-- inside a thread it started itself. Ownership is recorded here when an
-- owner surface sends mail through the EMAIL_SEND protocol, so receipts,
-- newsletters, and the owner's real correspondence are never candidates
-- and no allowlist has to be curated. Deleting a row silently ends the
-- coworker's involvement in that thread.

create table if not exists public.email_coworker_threads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  -- Gmail threadId / Graph conversationId, as returned by the send.
  thread_id text not null,
  subject text,
  -- Who the coworker is corresponding with (the delegate/prospect), lower
  -- cased. Replies to anyone else on the thread are still evaluated; this
  -- is context for the turn and the dashboard.
  correspondent_email text,
  -- RFC Message-Id of the last message we sent, for In-Reply-To/References.
  last_sent_message_ref text,
  -- Autonomous replies sent on this thread; bounded per day by the caller.
  turns integer not null default 0,
  turns_day date,
  -- Set when the thread is escalated to a human: the coworker stops
  -- answering and the owner was alerted.
  handed_off boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, thread_id)
);

-- The poller scans owned threads per business, newest activity first.
create index if not exists idx_email_coworker_threads_business_updated
  on public.email_coworker_threads (business_id, updated_at desc);

-- Evaluation markers, mirroring ai_flow_email_seen: a message is read once,
-- whether or not it produced a reply, so a poll's read budget only goes to
-- genuinely new mail and a crash mid-batch cannot double-answer.
create table if not exists public.email_coworker_seen (
  business_id uuid not null references public.businesses(id) on delete cascade,
  message_id text not null,
  seen_at timestamptz not null default now(),
  primary key (business_id, message_id)
);

create index if not exists idx_email_coworker_seen_at
  on public.email_coworker_seen (seen_at);

alter table public.email_coworker_threads enable row level security;
alter table public.email_coworker_seen enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").

grant select, insert, update, delete on table public.email_coworker_threads to service_role;
grant select, insert, update, delete on table public.email_coworker_seen to service_role;

-- The coworker's own replies render distinctly from dashboard-chat and
-- owner-typed mail on the Emails page.
alter table public.email_log drop constraint if exists email_log_source_check;
alter table public.email_log add constraint email_log_source_check
  check (
    source in (
      'ai_flow',
      'owner_mailbox',
      'email_trigger',
      'dashboard_chat',
      'sms_assistant',
      'voice_assistant',
      'tenant_mailbox_inbound',
      'tenant_mailbox_outbound',
      'owner_manual',
      'email_coworker'
    )
  );
