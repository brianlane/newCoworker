-- Automatic Zoom meeting-transcript import (webhook auto-import, Jul 2026).
--
-- 1. `zoom_connections.auto_import_transcripts`: per-tenant switch for the
--    recording.transcript_completed webhook path. Default ON: the minutes
--    condensation runs the cheap document model and meters into the tenant's
--    own shared AI budget, so the magic-by-default posture costs the
--    platform nothing incremental.
-- 2. `zoom_transcript_imports`: idempotency ledger keyed by
--    (business_id, meeting_uuid). Webhook retries and manual-then-webhook
--    overlap collapse to a single imported document.

alter table public.zoom_connections
  add column if not exists auto_import_transcripts boolean not null default true;

create table if not exists public.zoom_transcript_imports (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Zoom's past-meeting instance UUID (raw, unencoded).
  meeting_uuid text not null,
  -- The document the import produced; null while the claim is in flight.
  document_id uuid,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_zoom_transcript_imports_business_meeting
  on public.zoom_transcript_imports (business_id, meeting_uuid);

-- Service-role-only posture: RLS on, zero policies (matches zoom_connections).
alter table public.zoom_transcript_imports enable row level security;
grant select, insert, update, delete on table public.zoom_transcript_imports to service_role;
