-- ---------------------------------------------------------------------------
-- contacts.name_source: track whether a contact's display_name was set by the
-- OWNER (manual) or captured automatically (auto), decoupled from `type`.
--
-- Why: before this, the only signal for "is this name a deliberate label?" was
-- the `type` column (resolveContactNames treated type != 'customer' as a manual
-- label that wins over a derived owner/employee name; type = 'customer' as an
-- auto/owner-edited profile the overlay was allowed to override). That conflated
-- WHAT a contact is (`type`) with WHERE its name came from. The practical bug:
--   * we could not distinguish an owner-set name from an auto-captured one on a
--     customer-typed row, and
--   * a manual name on an owner/employee number was overridden by the derived
--     identity unless the owner re-tagged the contact's `type` to 'other' — a
--     confusing "set type to make a label stick" workaround.
--
-- After this migration, `name_source` carries the provenance and `type` goes
-- back to meaning only the contact category. The resolver keys "this name wins
-- over the owner/employee overlay" off name_source = 'manual', so a manual name
-- sticks regardless of type and the legacy workaround is removed.
-- ---------------------------------------------------------------------------

alter table public.contacts
  add column if not exists name_source text not null default 'auto';

alter table public.contacts
  drop constraint if exists contacts_name_source_chk;
alter table public.contacts
  add constraint contacts_name_source_chk
  check (name_source in ('auto', 'manual'));

comment on column public.contacts.name_source is
  'Provenance of display_name: manual (owner set it via the contacts UI / set-contact / add-customer) or auto (captured from SMS/voice or derived). A manual name wins over the read-time owner/employee overlay in src/lib/db/contact-names.ts; an auto name does not. Independent of `type`.';

-- Backfill: every non-customer row today is a folded contact_overrides label or
-- an owner-tagged contact (tester/service/other) — i.e. a deliberately set name.
-- Mark those 'manual' so resolution behaviour is unchanged at migration time.
-- Customer-typed rows keep the 'auto' default (their names were auto-captured or
-- owner-edited via fill-only writes; provenance is tracked precisely going
-- forward by the writers stamping name_source).
update public.contacts
   set name_source = 'manual'
 where type <> 'customer'
   and name_source <> 'manual';
