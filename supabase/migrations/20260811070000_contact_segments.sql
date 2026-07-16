-- ---------------------------------------------------------------------------
-- Version stamp note: the production ledger is ahead of real time (stamps
-- run through 20260811063723), and `supabase db push` refuses local files
-- that sort before the remote max — so a real `date -u` stamp (2026-07-16)
-- cannot deploy. This continues the ledger's sequence immediately after the
-- current max, same convention as the pipelines migration before it.
-- ---------------------------------------------------------------------------
-- Contact segments ("Smart Lists", FUB-style): named saved filter sets the
-- team works as one-click lists on the Contacts page.
--
-- A segment stores only its FILTERS (jsonb, validated app-side by
-- segmentFiltersSchema); membership is evaluated live over each contact's
-- current facts — tags, type, owner, last interaction age — so lists can
-- never go stale and there is no membership table to maintain.
--
-- Caps (enforced in the API): 20 segments per business, names <= 60 chars.
-- ---------------------------------------------------------------------------

create table if not exists contact_segments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  filters jsonb not null default '{}'::jsonb,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- List names are the team's mental model ("Hot leads", "No contact 5d") —
-- duplicates within a business would make the chip row ambiguous.
create unique index if not exists uq_contact_segments_business_name
  on contact_segments (business_id, lower(name));

create index if not exists idx_contact_segments_business
  on contact_segments (business_id, position);

-- Deny-by-default: RLS on with no policies. All reads/writes go through the
-- Next.js server (service role, which bypasses RLS) after requireBusinessRole
-- checks — anon/authenticated get an unconditional deny, matching the
-- platform posture ("RLS enabled, no policies" is the design, not a gap).
alter table contact_segments enable row level security;

comment on table contact_segments is
  'Smart Lists: named saved contact filter sets (FUB-style). Filters jsonb is validated app-side; membership is evaluated live over contacts.';
