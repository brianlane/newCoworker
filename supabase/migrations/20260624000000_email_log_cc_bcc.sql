-- CC/BCC support for coworker email. Outbound sends (AiFlow, owner-mailbox,
-- and the dashboard/SMS/voice assistant adapters) can now copy additional
-- recipients; record them so the dashboard Emails page can show who was copied.
-- Stored as a comma-separated address list (nullable: most rows have none).
alter table public.email_log add column if not exists cc_email text;
alter table public.email_log add column if not exists bcc_email text;

comment on column public.email_log.cc_email is
  'Comma-separated cc recipients for an outbound coworker email, or null when none.';
comment on column public.email_log.bcc_email is
  'Comma-separated bcc recipients for an outbound coworker email, or null when none.';
