-- Soft delete for owner-deletable dashboard items.
--
-- Owners can now "delete" notifications, emails, calls, SMS conversations,
-- and dashboard chat threads. The delete is SOFT: rows get a `deleted_at`
-- stamp (+ `deleted_by` auth user id for the audit trail) and every
-- owner-facing read filters them out, so from the dashboard it is
-- indistinguishable from a hard delete. Restore is admin-only
-- (/api/admin/deleted-items) and simply clears the stamp.
--
-- Lifecycle: soft-deleted rows are NOT retained forever — the daily
-- retention sweep and verified end-user erasure keep HARD-deleting rows
-- regardless of the stamp, so a soft delete never extends data lifetime.
--
-- Residency: five of these tables are RESIDENCY_MOVED_TABLES; the same
-- columns are added to the box datastore schema (vps/data-api/schema.sql)
-- so journaled upserts carrying the stamp keep applying. `sms_inbound_jobs`
-- is a central-only engine table.

alter table public.notifications add column if not exists deleted_at timestamptz;
alter table public.notifications add column if not exists deleted_by uuid;

alter table public.email_log add column if not exists deleted_at timestamptz;
alter table public.email_log add column if not exists deleted_by uuid;

alter table public.voice_call_transcripts add column if not exists deleted_at timestamptz;
alter table public.voice_call_transcripts add column if not exists deleted_by uuid;

alter table public.sms_outbound_log add column if not exists deleted_at timestamptz;
alter table public.sms_outbound_log add column if not exists deleted_by uuid;

alter table public.sms_inbound_jobs add column if not exists deleted_at timestamptz;
alter table public.sms_inbound_jobs add column if not exists deleted_by uuid;

alter table public.dashboard_chat_threads add column if not exists deleted_at timestamptz;
alter table public.dashboard_chat_threads add column if not exists deleted_by uuid;

-- Deleted rows are rare, so the admin "deleted items" listing gets tiny
-- partial indexes; live-row list queries keep using the existing
-- (business_id, created_at) indexes — the `deleted_at is null` predicate
-- is a cheap residual filter on an already-selective scan.
create index if not exists notifications_deleted_idx
  on public.notifications (business_id, deleted_at desc) where deleted_at is not null;
create index if not exists email_log_deleted_idx
  on public.email_log (business_id, deleted_at desc) where deleted_at is not null;
create index if not exists voice_call_transcripts_deleted_idx
  on public.voice_call_transcripts (business_id, deleted_at desc) where deleted_at is not null;
create index if not exists sms_outbound_log_deleted_idx
  on public.sms_outbound_log (business_id, deleted_at desc) where deleted_at is not null;
create index if not exists sms_inbound_jobs_deleted_idx
  on public.sms_inbound_jobs (business_id, deleted_at desc) where deleted_at is not null;
create index if not exists dashboard_chat_threads_deleted_idx
  on public.dashboard_chat_threads (business_id, deleted_at desc) where deleted_at is not null;
