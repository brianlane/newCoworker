-- A third clickwrap acceptance source: 'admin_view_as'.
--
-- Admin "view as" used to refuse every mutation, which included the
-- re-acceptance gate: an operator could not accept the Terms on a tenant's
-- behalf. Impersonation is now full access, so that click IS possible, and
-- the ledger has to be able to say who actually made it.
--
-- Without a distinct source, an operator-recorded row would be
-- indistinguishable from the tenant clicking "I agree" themselves: a
-- fabricated-consent record in a table whose entire purpose is evidence.
-- With it, "did this tenant personally accept?" stays answerable: filter
-- source in ('signup', 'gate'). Rows stay insert-only; the `email`/`user_id`
-- columns keep identifying the TENANT (whose consent it is), and the source
-- is what marks the operator's hand.
--
-- No new objects, so no new Data API grants are needed: the existing
-- service_role select/insert grants on public.terms_acceptances (migration
-- 20260822044511) still cover every reader and writer.
-- grants: none (constraint change only): the table's grants are unchanged.
alter table public.terms_acceptances
  drop constraint if exists terms_acceptances_source_check;

alter table public.terms_acceptances
  add constraint terms_acceptances_source_check
  check (source in ('signup', 'gate', 'admin_view_as'));
