create table if not exists onboarding_drafts (
  business_id uuid primary key,
  draft_token uuid not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists onboarding_drafts_draft_token_idx
  on onboarding_drafts(draft_token);
