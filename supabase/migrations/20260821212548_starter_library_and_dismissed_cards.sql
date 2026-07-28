-- Two additions that let the curated starter flows live in the public library
-- and let an owner hide the starter cards on the AiFlows page.
--
-- 1. ai_flow_library.source distinguishes the hourly community aggregation
--    (flows real tenants ran successfully) from the code-defined starters
--    published by src/lib/ai-flows/templates.ts. The browse/detail UI badges
--    starters and skips the "personal details were removed" footnote, which is
--    only true of scrubbed tenant flows.
-- 2. user_dismissed_cards records per-user dismissals of promo/starter cards,
--    keyed by the auth user id like user_sidebar_items.

-- ---------------------------------------------------------------------------
-- ai_flow_library.source
-- ---------------------------------------------------------------------------
alter table public.ai_flow_library
  add column if not exists source text not null default 'community';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_flow_library_source_check'
  ) then
    alter table public.ai_flow_library
      add constraint ai_flow_library_source_check check (source in ('community', 'starter'));
  end if;
end
$$;

comment on column public.ai_flow_library.source is
  'community = aggregated from tenant flows with successful runs (scrubbed); starter = curated, code-defined template from src/lib/ai-flows/templates.ts (no tenant data, published verbatim).';

-- ---------------------------------------------------------------------------
-- user_dismissed_cards
-- ---------------------------------------------------------------------------
create table if not exists public.user_dismissed_cards (
  user_id uuid not null,
  card_key text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, card_key)
);

alter table public.user_dismissed_cards enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated have no access.
-- Reads/writes go through the Next.js server after its own auth checks.

grant select, insert, update, delete on table public.user_dismissed_cards to service_role;

comment on table public.user_dismissed_cards is
  'Per-user dismissals of dashboard promo/starter cards. Card keys are the stable identifiers in src/lib/dashboard/dismissed-cards.ts. Service-role-only.';
