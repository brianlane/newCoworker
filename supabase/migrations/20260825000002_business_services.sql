-- Structured services catalog (BizBlasts-inspired, Phase 2 of the document
-- knowledge plan).
--
-- A first-class `business_services` table (name / duration / price / active)
-- editable from the dashboard. Rendered into `business_configs.profile_md`
-- alongside hours/address, so every grounded surface — knowledge lookups,
-- the on-VPS vault, voice/SMS prompts, calendar tools — quotes exact prices
-- and books the right duration instead of guessing from prose.
--
-- Security posture: RLS on, no policies — service-role only, writes go
-- through owner-authenticated Next.js routes (same as business_documents).

create table if not exists business_services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  description text not null default '',
  -- Appointment length used for calendar slot matching. NULL = not
  -- time-boxed (e.g. product or flat-fee service).
  duration_minutes integer
    check (duration_minutes is null or (duration_minutes >= 5 and duration_minutes <= 1440)),
  -- Free-form price copy ("$40", "from $99", "$120/hr") — grounding text,
  -- not a billing amount, so no currency machinery.
  price_text text not null default '',
  active boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_business_services_business
  on business_services (business_id, position, created_at);

alter table business_services enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated denied by design.
