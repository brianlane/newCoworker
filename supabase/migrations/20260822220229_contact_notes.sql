-- ---------------------------------------------------------------------------
-- Contact notes: authored, timestamped note records on a contact.
--
-- Until now the only free-text home for "what we know about this person" was
-- contacts.pinned_md, one shared blob with no author and no history. This
-- table gives each note its own row:
--
--   contact_id      - the contact the note is about, following the
--                     business_documents.contact_id pattern exactly:
--                     nullable FK, ON DELETE SET NULL (deleting the contact
--                     keeps the rows, which simply stop being listed; the
--                     dashboard delete route removes them explicitly, and a
--                     contact merge re-points them to the survivor in the
--                     merge API route).
--   author_user_id  - the auth user who wrote it. Deliberately NO FK: the
--                     auth user may be deleted later and the note must keep
--                     naming its author (phi_access_log precedent). Used for
--                     the "edit/delete your own notes" checks.
--   author_label    - display-name snapshot at write time (roster name, else
--                     the login email), so the note reads the same even
--                     after roster/account churn.
--   body            - the note text. Capped at 4000 chars in app code
--                     (src/lib/notes/core.ts), not by a DB constraint,
--                     matching how pinned_md/summary_md caps are enforced.
--   deleted_at      - soft delete. Deleted notes stay out of every listing
--                     but remain for audit until the business cascade.
--
-- Service-role only (RLS on, zero policies): every access flows through the
-- Next.js dashboard API after its own auth checks, matching the
-- business_documents posture.
-- ---------------------------------------------------------------------------

create table if not exists public.contact_notes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  author_user_id uuid,
  author_label text not null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.contact_notes enable row level security;

-- Contact page "notes for this person" listing, newest first. Partial like
-- idx_business_documents_contact: rows whose contact was deleted drop out of
-- the index along with every listing.
create index if not exists idx_contact_notes_contact
  on public.contact_notes (business_id, contact_id, created_at desc)
  where contact_id is not null;

comment on table public.contact_notes is
  'Authored, timestamped notes on a contact (the structured successor to the single contacts.pinned_md blob, which stays untouched). Soft-deleted via deleted_at; author_label is a display-name snapshot at write time. Service-role only.';
comment on column public.contact_notes.contact_id is
  'Contact this note is about (business_documents.contact_id pattern). SET NULL when the contact is deleted; the dashboard delete route removes the notes explicitly and the merge route re-points them to the surviving profile.';
comment on column public.contact_notes.author_user_id is
  'Auth user who wrote the note; no FK so the note survives account deletion. Drives the "edit/delete own notes" ownership checks.';
comment on column public.contact_notes.author_label is
  'Display-name snapshot at write time (roster member name, else login email).';
comment on column public.contact_notes.deleted_at is
  'Soft delete: set instead of removing the row, so listings exclude it while the record remains until the business cascade.';

grant select, insert, update, delete on table public.contact_notes to service_role;
