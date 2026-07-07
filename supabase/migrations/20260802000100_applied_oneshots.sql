-- Ledger of applied one-shot scripts (scripts/oneshot/*).
--
-- One-shots are the de-facto data-migration system: idempotent, dry-run-first
-- scripts that patch stored AiFlow definitions and similar rows. They are safe
-- to re-run, but until now NOTHING recorded which script had been applied to
-- which business — answering "has simplify-claim-options run everywhere?"
-- meant re-auditing the data by hand. Each --apply now inserts a row here via
-- scripts/oneshot/_ledger.ts, making that answer a query.
--
-- Append-only by convention: a re-run inserts another row (the history of
-- applications is itself useful), so there is no unique constraint on
-- (script, business_id).
create table if not exists public.applied_oneshots (
  id bigint generated always as identity primary key,
  -- Script basename, e.g. "add-pass-option-copy.ts".
  script text not null,
  -- Business the apply targeted; null for global/multi-tenant scripts.
  business_id uuid references public.businesses(id) on delete set null,
  -- Free-form summary of what changed (e.g. patched flow ids/names).
  details jsonb,
  applied_at timestamptz not null default now()
);

alter table public.applied_oneshots enable row level security;

drop policy if exists "Service role manages applied_oneshots" on public.applied_oneshots;
create policy "Service role manages applied_oneshots"
  on public.applied_oneshots for all
  using (auth.role() = 'service_role');

create index if not exists applied_oneshots_script_idx
  on public.applied_oneshots (script, applied_at desc);
