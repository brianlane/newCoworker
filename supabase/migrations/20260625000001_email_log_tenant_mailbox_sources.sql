-- Widen email_log.source so the per-tenant AI mailbox can record both
-- directions distinctly:
--   tenant_mailbox_inbound  - mail received at <tenant>@<domain> (may trigger a flow)
--   tenant_mailbox_outbound - mail the coworker sent FROM <tenant>@<domain> via Resend
-- Kept separate from the existing `email_trigger` / `ai_flow` values so the
-- dashboard can tell owner-mailbox activity apart from the AI's own mailbox.
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
      'tenant_mailbox_outbound'
    )
  );
