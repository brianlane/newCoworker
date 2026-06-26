-- Rename the 'service' contact type to 'company'.
--
-- 'service' was the catch-all for lead-source / vendor short codes and
-- non-person directory rows. 'company' reads more clearly in the contacts UI
-- for the owner. The set is otherwise unchanged; keep this migration and the
-- app-side CONTACT_TYPES list (src/lib/customer-memory/types.ts) in lockstep.

-- Drop the constraint first so the relabel update can't trip the old CHECK
-- (which still forbids 'company').
alter table public.contacts
  drop constraint if exists contacts_type_chk;

-- Relabel any existing rows. (None at write time, but kept idempotent so the
-- migration is correct regardless of when it lands.)
update public.contacts
   set type = 'company'
 where type = 'service';

alter table public.contacts
  add constraint contacts_type_chk
  check (type in ('owner', 'employee', 'customer', 'tester', 'company', 'other'));
