-- Store the FULL message body on email_log (the reading pane on the dashboard
-- Emails page shows the complete email, not just the list preview).
--
-- Until now email_log only kept `body_preview` (first 500 chars) for the list.
-- `body_full` holds the entire plain-text body. Nullable: older rows keep only
-- their preview, and the dashboard falls back to `body_preview` when null.
alter table public.email_log add column if not exists body_full text;

comment on column public.email_log.body_full is
  'Full plain-text message body for the dashboard reading pane. Nullable; pre-existing rows only have body_preview.';
