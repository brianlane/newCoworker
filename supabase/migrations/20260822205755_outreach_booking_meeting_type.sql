-- Which meeting a cold email's booking link points at.
--
-- The pitch's CTA has always linked the booking PAGE, which for a tenant with
-- more than one meeting type is a chooser: "what would you like to book?".
-- That is the wrong question to put in front of a stranger who has read one
-- paragraph about missed calls. Naming the meeting turns the click into a
-- calendar, and the choice belongs to the owner, per outreach rather than
-- globally: the coworker still offers the whole menu everywhere else.
--
-- Null keeps the old behavior (link the page, let them choose), so every
-- existing tenant is unaffected until they pick one.
--
-- ON DELETE SET NULL rather than CASCADE: deleting a meeting type must not
-- delete the tenant's outreach configuration. The link simply falls back to
-- the chooser page, which is exactly what a deleted meeting should do.
alter table public.outreach_settings
  add column if not exists booking_meeting_type_id uuid
    references public.booking_meeting_types (id) on delete set null;

comment on column public.outreach_settings.booking_meeting_type_id is
  'Meeting type the outreach CTA links directly to. Null means link the booking page and let the recipient choose.';

-- grants: none (outreach_settings): existing table, already granted; this adds
-- a column, not an object.
