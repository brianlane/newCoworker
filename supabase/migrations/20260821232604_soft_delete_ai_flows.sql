-- Soft delete for AiFlows (config rows, not content history).
--
-- Owner / view-as "delete" on an AiFlow stamps deleted_at (+ deleted_by)
-- and forces enabled=false so trigger discovery that filters enabled=true
-- stops firing even if a deleted_at filter is missed. Owner-facing list/get
-- hide stamped rows; admin restore (/api/admin/deleted-items) clears the
-- stamp and leaves the flow disabled so it does not re-arm immediately.
--
-- Retention does NOT prune ai_flows: soft delete here is for recovery, not
-- a content-history lifetime. Runs stay attached (FK) so history survives.
--
-- Residency: ai_flows is a RESIDENCY_MOVED_TABLE; the same columns are
-- added to the box datastore schema (vps/data-api/schema.sql).

alter table public.ai_flows add column if not exists deleted_at timestamptz;
alter table public.ai_flows add column if not exists deleted_by uuid;

create index if not exists ai_flows_deleted_idx
  on public.ai_flows (business_id, deleted_at desc) where deleted_at is not null;
