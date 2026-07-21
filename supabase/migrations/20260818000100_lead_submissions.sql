-- ---------------------------------------------------------------------------
-- Version stamp note: the production ledger is ahead of real time (legacy
-- invented stamps run through 20260818000000), and `supabase db push`
-- refuses local files that sort before the remote max — so a real
-- `date -u` stamp (2026-07-21) cannot deploy. This continues the ledger's
-- sequence (…000000, …000100, …000200), same as the pipelines migration.
-- ---------------------------------------------------------------------------
-- Durable per-lead submission records for the Tasks "Data" grid and the
-- Meta Conversions API (Conversion Leads) feedback loop.
--
-- Every inbound webhook flow event (direct Meta Lead Ads, the Zapier /
-- Make / Privyr bridges, lead-backlog imports) records one row here at
-- delivery time, BEFORE any flow runs: the flattened answers (`fields`),
-- the source label, the Meta leadgen id when the event carries one, and
-- best-effort phone/email identifiers extracted from the answers. The
-- Tasks page's Data view joins these rows onto contacts by phone/email at
-- read time (no FK — the contact usually doesn't exist yet when the lead
-- arrives), and the CAPI outbox resolves a stage-changed contact back to
-- its `leadgen_id` the same way.
--
-- Security posture: RLS on with NO policies (service-role only), matching
-- the other tenant-content tables (see README "RLS enabled, no policies").

create table if not exists public.lead_submissions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Caller-supplied source label ("facebook_lead_ads", "zapier", ...).
  source text not null,
  -- The webhook event's idempotency key (webhookEventKey) — one row per
  -- delivered event, redeliveries are no-ops.
  event_key text not null,
  -- Meta's 15-17 digit lead id (Lead Ads only) — the Conversion Leads
  -- match key uploaded back to Meta.
  leadgen_id text,
  -- The flattened, size-bounded lead answers ({question: answer}).
  fields jsonb not null default '{}'::jsonb,
  -- Best-effort identifiers extracted from the answers at write time.
  phone_e164 text,
  email text,
  created_at timestamptz not null default now()
);

comment on table public.lead_submissions is
  'One row per inbound lead webhook event: flattened answers + extracted identifiers. Read by the Tasks Data view (joined to contacts by phone/email) and the Meta CAPI feedback outbox (leadgen_id lookup).';

-- Exactly-once per delivered event (the insert is an ignore-duplicates upsert).
create unique index if not exists uq_lead_submissions_business_event
  on public.lead_submissions (business_id, event_key);

-- The Data view and CAPI lookups join by identifier, newest first.
create index if not exists idx_lead_submissions_business_phone
  on public.lead_submissions (business_id, phone_e164)
  where phone_e164 is not null;
create index if not exists idx_lead_submissions_business_email
  on public.lead_submissions (business_id, email)
  where email is not null;
create index if not exists idx_lead_submissions_business_created
  on public.lead_submissions (business_id, created_at desc);

alter table public.lead_submissions enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design.
