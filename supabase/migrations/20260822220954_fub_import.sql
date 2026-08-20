-- ---------------------------------------------------------------------------
-- Follow Up Boss import: job state plus external-id idempotency columns.
--
-- 1) fub_import_jobs
--
--    One row per import attempt from /dashboard/import-export. The flow is
--    two-step: creating a job validates the key and runs a DRY RUN (counts +
--    a smart-list/action-plan inventory into `counts`), then the real run
--    executes in resumable chunks, advancing `cursor` after every page so a
--    timed-out or re-issued run continues instead of starting over.
--
--    status funnel: pending -> dry_run_done -> running -> done | failed.
--
--    api_key_encrypted holds the tenant's FUB API key encrypted with the
--    same app-layer envelope as slack_connections.bot_token_encrypted /
--    meta_connections (encryptIntegrationSecret). NULLABLE on purpose: the
--    "delete saved key" endpoint nulls it while the job row keeps the
--    counts, so the result summary survives the key's deletion. Ciphertext
--    never leaves the server; the dashboard only ever sees has_api_key.
--
--    counts is a jsonb report: the dry-run totals/inventory and the real
--    run's created/updated/skipped tallies plus the first few failure
--    reasons. cursor is the resume point: phase (people/notes/deals/done),
--    the FUB keyset `next` token, the offset fallback, and the cached
--    deal-stage name map.
--
--    created_by is the auth user who started the import; informational only
--    (no FK: user deletion must not cascade into import history), matching
--    deals.created_by.
--
--    Service-role only (RLS on, zero policies): every access goes through
--    the Next.js dashboard API after requireBusinessRole, the same posture
--    as deals / contact_notes.
--
-- 2) deals.external_source/external_id, contact_notes.external_source/
--    external_id
--
--    Imported rows carry ('fub', <fub id>) so a re-run UPSERTS instead of
--    duplicating. The unique index is deliberately NOT partial: PostgREST's
--    on_conflict can only infer a full unique index (it cannot emit the
--    partial index's WHERE predicate in the ON CONFLICT clause), and SQL
--    NULLs are distinct, so rows created by hand (external_id null) never
--    collide with each other anyway. Same effective semantics as the
--    partial shape, plus a working upsert path.
-- ---------------------------------------------------------------------------

create table public.fub_import_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'dry_run_done', 'running', 'done', 'failed')),
  -- True until the owner confirms the real run; the dry run never writes.
  dry_run boolean not null default true,
  -- FUB API key, encryptIntegrationSecret envelope. NULL = wiped by the
  -- owner (or superseded by a newer job); the run endpoint refuses then.
  api_key_encrypted text,
  counts jsonb not null default '{}',
  cursor jsonb not null default '{}',
  error text,
  -- auth.users id of the dashboard user who started the import; no FK so
  -- account deletion never cascades into import history (deals precedent).
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The status card's read: this business's imports, newest first.
create index idx_fub_import_jobs_business
  on public.fub_import_jobs (business_id, created_at desc);

comment on table public.fub_import_jobs is
  'Follow Up Boss import jobs: dry-run counts/inventory, then a chunked resumable real run (cursor advances per page). API key encrypted at rest and nullable so "delete saved key" can wipe it while the result report stays.';
comment on column public.fub_import_jobs.api_key_encrypted is
  'Tenant FUB API key, encryptIntegrationSecret envelope (slack/meta precedent). NULL after the owner deletes the saved key; the dashboard only ever sees a has_api_key boolean.';
comment on column public.fub_import_jobs.counts is
  'Dry-run totals + smart-list/action-plan inventory, then the real run tallies (created/updated/skipped, first failure reasons).';
comment on column public.fub_import_jobs.cursor is
  'Resume point: phase (people/notes/deals/done), FUB keyset next token, offset fallback, cached deal-stage names. Updated after every imported page.';

alter table public.fub_import_jobs enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated denied by design.
grant select, insert, update, delete on table public.fub_import_jobs to service_role;

-- Idempotency keys for imported deals.
alter table public.deals
  add column if not exists external_source text,
  add column if not exists external_id text;

comment on column public.deals.external_source is
  'Source system for an imported deal ("fub"); NULL for deals created in the dashboard.';
comment on column public.deals.external_id is
  'The deal''s id in external_source, making re-imports upsert instead of duplicate. NULL for native deals (SQL NULLs are distinct, so the unique index never binds them).';

create unique index uq_deals_external
  on public.deals (business_id, external_source, external_id);

-- Idempotency keys for imported notes.
alter table public.contact_notes
  add column if not exists external_source text,
  add column if not exists external_id text;

comment on column public.contact_notes.external_source is
  'Source system for an imported note ("fub"); NULL for notes written in the dashboard.';
comment on column public.contact_notes.external_id is
  'The note''s id in external_source, making re-imports upsert instead of duplicate. NULL for native notes (SQL NULLs are distinct, so the unique index never binds them).';

create unique index uq_contact_notes_external
  on public.contact_notes (business_id, external_source, external_id);
