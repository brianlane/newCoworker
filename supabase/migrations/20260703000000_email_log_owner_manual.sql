-- Add `owner_manual` to email_log.source so owner-initiated dashboard emails
-- (reply-in-thread + compose-new on the Emails page, sent from the owner's
-- connected mailbox) render distinctly from the AI coworker's own sends.
-- Mirrors the SMS owner_manual source added in 20260702000000.
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
      'owner_manual'
    )
  );
