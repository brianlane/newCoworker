-- Email organization fields on email_log (AI mailbox in-app inbox).
-- Soft-delete (deleted_at) stays separate from archive.
-- grants: none (columns inherit the table grants from email_log creation).

alter table public.email_log
  add column if not exists is_read boolean not null default false;

alter table public.email_log
  add column if not exists archived_at timestamptz;

alter table public.email_log
  add column if not exists folder text;

alter table public.email_log
  add column if not exists labels text[] not null default '{}'::text[];

-- Inbox-style listing: live (non-deleted) rows by business, archive state, recency.
create index if not exists email_log_organize_inbox_idx
  on public.email_log (business_id, archived_at, created_at desc)
  where deleted_at is null;
