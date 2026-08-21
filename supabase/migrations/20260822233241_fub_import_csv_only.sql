-- ---------------------------------------------------------------------------
-- Follow Up Boss import moves from their API to the owner's own CSV export.
--
-- WHY: the Follow Up Boss API Terms of Use require registering a system,
-- forbid using the API or its data to offer a product that competes with
-- them, and forbid retaining their data beyond what an integration needs. A
-- one-way migration off their platform is none of those things. Their own
-- help center points customers at People -> Export All Columns to move to
-- another system, so that export, handed over by the person who owns it, is
-- the path the importer now takes.
--
-- Two columns exist only to serve the API flow and are dropped:
--
--   api_key_encrypted  The tenant's FUB API key at rest. Nothing asks for a
--                      key any more, so the safest version of this column is
--                      no column. Verified empty before writing this
--                      migration: fub_import_jobs held ZERO rows in
--                      production, so no customer key is being destroyed and
--                      none was ever stored.
--   cursor             The resume point for the chunked API pager. A CSV
--                      import is a single request over at most
--                      MAX_IMPORT_ROWS rows, so there is nothing to resume.
--
-- `counts` keeps carrying the report, now { preview } after a dry run and
-- { preview, summary } after a real one. The status funnel is unchanged
-- (pending -> dry_run_done | done | failed), so the check constraint stays.
--
-- deals.external_source/external_id and contact_notes.external_source/
-- external_id are deliberately LEFT IN PLACE. The CSV export carries neither
-- notes nor deals so the importer no longer writes them, but the columns and
-- their unique indexes are the generic "this row came from somewhere else"
-- idempotency key, and dropping a unique index is not worth the churn for a
-- column that costs nothing empty.
-- ---------------------------------------------------------------------------

alter table public.fub_import_jobs drop column if exists api_key_encrypted;
alter table public.fub_import_jobs drop column if exists cursor;

comment on table public.fub_import_jobs is
  'Follow Up Boss import jobs, driven by the owner''s own CSV export from People (Export All Columns), never by their API. One row per preview or import; counts holds { preview } then { preview, summary }. The file itself is never stored.';
comment on column public.fub_import_jobs.counts is
  'Dry run: { preview } (row totals, which file column fed which field, ignored columns, first unusable rows). Real run: adds { summary } (created/updated/skipped plus the first failures).';
comment on column public.fub_import_jobs.dry_run is
  'True for a preview (parses and reports, writes nothing), false for a real import.';

-- grants: none (no new objects): this migration only drops columns from
-- fub_import_jobs, whose service_role grants were made when it was created.
