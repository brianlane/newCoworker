-- Per-tenant AI mailbox: inbound email attachments.
--
-- The Cloudflare Email Worker (service role) parses inbound MIME, uploads each
-- attachment's bytes to this private bucket, and posts compact metadata to
-- /api/email/inbound. The dashboard reading pane serves attachments via
-- short-lived signed URLs (the bucket is private, so direct access stays denied
-- by default — no storage RLS policies needed, only the service role touches it).
insert into storage.buckets (id, name, public, file_size_limit)
values ('email-attachments', 'email-attachments', false, 26214400) -- 25 MB per attachment
on conflict (id) do nothing;

-- Attachment metadata kept inline on the email_log row (filename, mime_type,
-- size_bytes, storage_path). The metadata is small; the bytes live in the bucket
-- above. Defaults to an empty array so every existing/new row reads cleanly.
alter table public.email_log
  add column if not exists attachments jsonb not null default '[]'::jsonb;

comment on column public.email_log.attachments is
  'Inbound attachment metadata: array of {filename, mime_type, size_bytes, storage_path}. File bytes live in the email-attachments bucket and are served via signed URLs.';
