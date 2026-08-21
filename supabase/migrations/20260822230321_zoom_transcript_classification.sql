-- Meeting-minutes classification, stamped onto the import ledger.
--
-- After a Zoom transcript is condensed into minutes, a classification pass
-- decides what the meeting WAS (signed / follow_up / not_a_fit / internal)
-- and applies that to the contact: it links the document, writes a note,
-- moves the pipeline card, and files the action items as to-dos.
--
-- Those writes must happen exactly once per meeting. The ledger already
-- serializes the IMPORT, but `reclaimCompletedZoomTranscriptImport` blanks
-- `document_id` so a deliberate manual re-import can produce a fresh
-- document; without a separate marker that re-import would also write a
-- SECOND note and a second set of to-dos. `classified_at` is that marker and
-- is deliberately NOT cleared by the reclaim: re-importing a meeting
-- re-files the document, it does not re-decide what the meeting meant.
--
-- It is a CLAIM, not a completion stamp: it is set before the classification
-- runs, by a conditional update that only matches while it is null, so the
-- pass itself (two model calls) is not a window in which a racing re-import
-- also sees "not yet classified". `outcome` is what separates a pass that
-- finished from one that claimed and then died; there is no lease, because
-- for a best-effort enrichment a missing note beats a duplicated one.
--
-- `contact_id` and `outcome` are recorded for the owner-facing trail (which
-- person the meeting was attributed to, and what it was read as), so a
-- mis-attribution is diagnosable after the fact rather than only visible as
-- a surprising note on the wrong contact.
--
-- grants: none (zoom_transcript_classification): no object is CREATED here.
-- All three statements are `alter table` against public.zoom_transcript_imports,
-- whose service-role grants were issued in 20260821000000_zoom_auto_transcript_import.sql
-- and continue to cover new columns.

alter table public.zoom_transcript_imports
  add column if not exists contact_id uuid references public.contacts(id) on delete set null;

alter table public.zoom_transcript_imports
  add column if not exists outcome text;

alter table public.zoom_transcript_imports
  add column if not exists classified_at timestamptz;

comment on column public.zoom_transcript_imports.contact_id is
  'Contact the meeting was attributed to, or null when no confident match was found. SET NULL on contact delete, matching business_documents.contact_id.';

comment on column public.zoom_transcript_imports.outcome is
  'What the classifier read the meeting as: signed, follow_up, not_a_fit, internal, or unclear. Written only when the pass completes, so null alongside a non-null classified_at means the pass claimed the meeting and never finished.';

comment on column public.zoom_transcript_imports.classified_at is
  'Claim marker for the classification pass, set BEFORE it runs by a conditional update that only matches while null, so two racing passes cannot both write a note. Non-null suppresses re-application on a deliberate manual re-import, which blanks document_id but never this. A non-null classified_at with a null outcome is a pass that claimed and then died.';
