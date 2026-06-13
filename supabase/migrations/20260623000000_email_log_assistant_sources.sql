-- The Emails page only showed AiFlow sends + trigger emails, but the
-- coworker can also send mail from the owner's connected mailbox via
-- dashboard chat, the SMS assistant, and voice calls — none of which were
-- recorded. Widen the source check so those adapters can log their sends.
alter table public.email_log drop constraint if exists email_log_source_check;
alter table public.email_log add constraint email_log_source_check
  check (
    source in (
      'ai_flow',
      'owner_mailbox',
      'email_trigger',
      'dashboard_chat',
      'sms_assistant',
      'voice_assistant'
    )
  );

comment on table public.email_log is
  'Append-only log of coworker email activity (AiFlow sends, owner-mailbox sends, assistant chat/SMS/voice sends, flow-triggering inbound emails). Read by the dashboard Emails page.';
