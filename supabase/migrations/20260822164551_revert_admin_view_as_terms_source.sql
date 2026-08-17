-- Remove the 'admin_view_as' clickwrap acceptance source.
--
-- Added earlier the same day (20260822163452, PR #1420) when admin view-as
-- became full access, on the theory that an operator-recorded consent row is
-- acceptable as long as it is LABELED as the operator's. That was the wrong
-- call and it is reverted here: a terms_acceptances row exists to evidence
-- that a SPECIFIC PERSON agreed, and nobody can agree on someone else's
-- behalf, so the row is fabricated no matter how it is labeled. Admin view-as
-- can now do everything for a tenant EXCEPT give consent.
--
-- Safe to narrow: the capability shipped and was withdrawn within the hour and
-- the source was verified to have zero rows in production before this ran. The
-- constraint is re-added rather than left permissive so a future writer cannot
-- reintroduce the value without deliberately changing this file.
--
-- grants: none (constraint change only): the table's grants are unchanged.
alter table public.terms_acceptances
  drop constraint if exists terms_acceptances_source_check;

alter table public.terms_acceptances
  add constraint terms_acceptances_source_check
  check (source in ('signup', 'gate'));
