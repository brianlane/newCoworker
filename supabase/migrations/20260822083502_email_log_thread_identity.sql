-- email_log: keep the identity a reply needs.
--
-- Inbound mail stored a provider message id and nothing else, so there was no
-- way to answer INSIDE a conversation. Every assistant email opened a new
-- thread beside the original, which is what the dashboard Reply button does
-- today and why an answered sales email never looked like an answer.
--
-- Two columns, because the two providers thread differently and a strict
-- client wants both:
--   thread_id    Gmail threadId / Graph conversationId. What the provider
--                files the conversation under.
--   message_ref  The RFC 5322 Message-Id header. What In-Reply-To and
--                References actually carry.
--
-- Nullable and null-by-default on purpose: every row that predates this has
-- neither, and a send whose target row lacks them goes out unthreaded rather
-- than failing. A blank identifier would be worse than a missing one, since
-- it reads as real and threads a reply against nothing.

alter table public.email_log
  add column if not exists thread_id text,
  add column if not exists message_ref text;

comment on column public.email_log.thread_id is
  'Provider conversation id (Gmail threadId / Graph conversationId). Null on rows predating the reply feature and on providers that expose none.';
comment on column public.email_log.message_ref is
  'RFC 5322 Message-Id header, what In-Reply-To/References carry when replying into this thread. Null when the provider did not supply one.';

-- Reply lookups resolve one row by id within a business, so the existing
-- primary key covers them. This index serves the other direction: finding the
-- rows of a known conversation (thread views, dedupe), which is the query a
-- thread id exists for.
create index if not exists email_log_business_thread_idx
  on public.email_log (business_id, thread_id)
  where thread_id is not null;
