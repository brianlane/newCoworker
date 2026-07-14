-- ---------------------------------------------------------------------------
-- Pipelines: named, ordered stage boards for lead state (GoHighLevel-style).
--
-- A pipeline is a set of ordered STAGES; each stage is BACKED BY A CONTACT
-- TAG (stage `name` == the tag string, matched case-insensitively). That
-- keeps the whole existing tag automation surface working unchanged:
--   * AiFlow `update_contact` steps move a lead between stages by swapping
--     tags,
--   * `tag_changed` triggers fire when a drag-and-drop move re-tags the
--     contact (the move endpoint fires the same contact-event hooks as the
--     dashboard tag editor),
--   * tag filtering/GIN indexes on contacts.tags serve the board queries.
-- There is deliberately NO opportunities table: the contact's tags are the
-- single source of truth for lead state, and the board is a VIEW over them.
--
-- Caps (enforced in the API, mirrored here for defense in depth): 10
-- pipelines per business, 15 stages per pipeline, stage names <= 40 chars
-- (the contact-tag length cap).
-- ---------------------------------------------------------------------------

create table if not exists pipelines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Pipeline names are the owner's mental model ("Sales", "Onboarding") —
-- duplicates within a business would make the picker ambiguous.
create unique index if not exists uq_pipelines_business_name
  on pipelines (business_id, lower(name));

create index if not exists idx_pipelines_business
  on pipelines (business_id, position);

create table if not exists pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references pipelines(id) on delete cascade,
  -- Denormalized for one-hop tenant scoping on stage reads/writes.
  business_id uuid not null references businesses(id) on delete cascade,
  -- The stage IS a contact tag: same 40-char cap as contacts.tags entries.
  name text not null check (char_length(name) between 1 and 40),
  -- Column accent in the board UI; a small named palette, validated app-side.
  color text not null default 'teal' check (char_length(color) <= 20),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Stage names are tags, and tags are matched case-insensitively everywhere
-- (update_contact, tag_changed, the dashboard editor) — two stages differing
-- only by case would be one indistinguishable tag.
create unique index if not exists uq_pipeline_stages_pipeline_name
  on pipeline_stages (pipeline_id, lower(name));

create index if not exists idx_pipeline_stages_pipeline
  on pipeline_stages (pipeline_id, position);

create index if not exists idx_pipeline_stages_business
  on pipeline_stages (business_id);

-- Deny-by-default: RLS on with no policies. All reads/writes go through the
-- Next.js server (service role, which bypasses RLS) after requireBusinessRole
-- checks — anon/authenticated get an unconditional deny, matching the
-- platform posture ("RLS enabled, no policies" is the design, not a gap).
alter table pipelines enable row level security;
alter table pipeline_stages enable row level security;

comment on table pipelines is
  'Named lead-state boards (GoHighLevel-style). Stages are backed by contact tags; the board is a view over contacts.tags.';
comment on table pipeline_stages is
  'Ordered stages of a pipeline. name == the contact tag that puts a contact in this stage (case-insensitive, 40-char tag cap).';
