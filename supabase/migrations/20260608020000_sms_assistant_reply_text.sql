-- Durable outbound (assistant) reply text for the dashboard SMS thread +
-- customer history.
--
-- Background: `sms_inbound_jobs.rowboat_reply_cached` was the only place the
-- worker stored the assistant's outbound reply, but it is a TRANSIENT Telnyx
-- retry buffer — `clearJobReplyCache()` nulls it after a successful send. The
-- dashboard read layer (listMessagesForCustomer / listSmsHistoryForCustomer)
-- treated it as the canonical outbound body, so every successfully delivered
-- reply silently disappeared from the thread, leaving only inbound customer
-- messages.
--
-- This column is written at send time alongside `rowboat_reply_cached` and is
-- NEVER cleared, giving the dashboard a stable record of what the Coworker
-- replied. Nullable: legacy rows (replies already cleared) stay null and the
-- read layer falls back to `rowboat_reply_cached` for any still-in-flight job.
alter table public.sms_inbound_jobs
  add column if not exists assistant_reply_text text;

comment on column public.sms_inbound_jobs.assistant_reply_text is
  'Durable copy of the assistant''s outbound SMS reply, written by sms-inbound-worker at send time and never cleared (unlike the transient rowboat_reply_cached retry buffer). Powers the dashboard SMS thread + customer history. Nullable for legacy rows.';
