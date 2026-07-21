-- ---------------------------------------------------------------------------
-- Version stamp note: continues the ahead-of-real-time ledger sequence
-- (see 20260818000100_lead_submissions.sql).
-- ---------------------------------------------------------------------------
-- Meta Conversions API (Conversion Leads) feedback loop.
--
-- Two pieces:
--   1. meta_connections gains the CAPI plumbing: the Page's dataset
--      (pixel) id — auto-discovered via POST /{page_id}/dataset at page
--      pick — and a per-tenant capi_enabled kill switch. Both stay
--      NULL/true-by-default; sends only happen once a dataset id exists,
--      which requires the platform app's ads_management/business_management
--      scopes (granted to connections made after Meta App Review clears).
--   2. meta_capi_events: an outbox of pipeline stage changes for leads
--      that originated from Meta Lead Ads. Stage-tag writers enqueue rows
--      (dedupe-keyed); a per-minute drain uploads them to
--      POST /{dataset_id}/events with action_source=system_generated and
--      the lead_submissions.leadgen_id as the match key, then marks them
--      sent/failed. Meta discards events older than 7 days, so the drain
--      gives up (status 'expired') past that window.
--
-- Security posture: RLS on with NO policies (service-role only).

alter table public.meta_connections
  add column if not exists dataset_id text,
  add column if not exists capi_enabled boolean not null default true;

comment on column public.meta_connections.dataset_id is
  'The connected Page''s Conversions API dataset (pixel) id, auto-discovered at page pick. NULL until the platform app''s token can call POST /{page_id}/dataset (post-App-Review scopes).';
comment on column public.meta_connections.capi_enabled is
  'Per-tenant kill switch for the Conversion Leads feedback loop. Sends require dataset_id AND this flag.';

create table if not exists public.meta_capi_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- The lead whose stage changed (contact primary at enqueue time).
  contact_e164 text not null,
  -- The CRM stage label uploaded as event_name (the pipeline stage tag).
  event_name text not null,
  -- When the stage change happened (CAPI event_time; must be after lead
  -- creation and within 7 days of upload).
  event_time timestamptz not null default now(),
  -- One event per (lead, stage) transition burst — a drag back and forth
  -- re-fires because the stamp differs; an exact redelivery does not.
  dedupe_key text not null,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'skipped', 'expired')),
  attempts integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.meta_capi_events is
  'Outbox of pipeline stage changes to upload to Meta''s Conversions API (Conversion Leads). Drained per-minute; leads resolve to their leadgen_id via lead_submissions at send time.';

create unique index if not exists uq_meta_capi_events_dedupe
  on public.meta_capi_events (business_id, dedupe_key);

-- The drain scans pending rows oldest-first.
create index if not exists idx_meta_capi_events_pending
  on public.meta_capi_events (status, created_at)
  where status = 'pending';

alter table public.meta_capi_events enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design.
