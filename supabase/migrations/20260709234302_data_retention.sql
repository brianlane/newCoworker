-- Admin-controlled data retention (security review G6).
--
-- `businesses.data_retention_days`: how long tenant CONTENT history
-- (messages, transcripts, email log — the residency purge's "history the
-- engine never re-reads" table set) is kept before the retention sweep
-- prunes it. NULL = keep forever (default, current behavior). The floor of
-- 30 days is enforced both here and in app code: shorter windows would
-- fight the billing grace flow and delete context the engine may still
-- legitimately surface to the owner.
--
-- Sweep: pg_cron → Edge `data-retention-sweep` → Next
-- /api/internal/data-retention-sweep → pruneExpiredContent() per tenant
-- (src/lib/privacy/retention.ts). Contacts are never pruned — retention
-- covers content history, not the tenant's customer directory; erasing a
-- person entirely is the separate admin deletion tool
-- (src/lib/privacy/deletion.ts).

alter table public.businesses
  add column if not exists data_retention_days integer;

alter table public.businesses
  drop constraint if exists businesses_data_retention_days_check;
alter table public.businesses
  add constraint businesses_data_retention_days_check
  check (data_retention_days is null or data_retention_days >= 30);

comment on column public.businesses.data_retention_days is
  'Content-history retention window in days (min 30). NULL = keep forever. Enforced by the data-retention-sweep cron; contacts are exempt (deletion tool handles full erasure).';
