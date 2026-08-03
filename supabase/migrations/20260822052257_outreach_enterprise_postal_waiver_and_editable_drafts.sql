-- Prospecting: an Enterprise waiver for the footer postal address, and drafts
-- the owner can edit or have rewritten.
--
-- TWO changes, both to tables created in 20260821202816_prospecting_outreach.sql.
--
-- 1. postal_address_exempt. The original check constraint made any mode but
--    'off' impossible without a postal address typed into the Prospecting
--    panel. Enterprise no longer has to type one: the footer falls back to the
--    business profile address (businesses.address), and when there is no
--    address anywhere the footer line is simply omitted. The waiver is a
--    RECORDED FLAG rather than a relaxed constraint, so the schema still
--    refuses a Standard tenant with no address: the app sets the flag from the
--    tier on every non-off save, and both the manual send and the sweep
--    re-check the tier at send time, so a downgrade stops the sends rather
--    than grandfathering them.
--
-- 2. pitch_paragraphs. The editable middle of a draft, stored apart from the
--    assembled pitch_body. The unsubscribe link and the postal address are
--    concatenated in code AFTER any AI polish (see src/lib/outreach/compose.ts),
--    and owner editing must not become the hole that drops them: the owner
--    edits these paragraphs, and the body is re-assembled around them by the
--    same code path the sweep uses. Null on rows drafted before this column
--    existed; the edit path strips whatever footer it finds on those and
--    re-appends the canonical one.
--
-- No new objects, so no new Data API grants: both tables already grant
-- service_role, and column privileges follow the table.

alter table public.outreach_settings
  add column if not exists postal_address_exempt boolean not null default false;

alter table public.outreach_settings
  drop constraint if exists outreach_settings_ready_when_on;

alter table public.outreach_settings
  add constraint outreach_settings_ready_when_on
  check (
    mode = 'off'
    or (
      (
        postal_address_exempt
        or (postal_address is not null and length(btrim(postal_address)) > 0)
      )
      and value_prop is not null
      and length(btrim(value_prop)) > 0
    )
  );

comment on column public.outreach_settings.postal_address_exempt is
  'True when the plan waives the typed footer address (Enterprise today). Written by the app from the business tier on every non-off save. It only relaxes outreach_settings_ready_when_on: the footer still prints businesses.address when one exists, and every send re-checks the tier.';

comment on column public.outreach_settings.postal_address is
  'Physical postal address printed in every pitch footer (CAN-SPAM requirement). Required by outreach_settings_ready_when_on unless postal_address_exempt is set, in which case the footer falls back to businesses.address.';

alter table public.outreach_prospects
  add column if not exists pitch_paragraphs text;

comment on column public.outreach_prospects.pitch_paragraphs is
  'The editable middle of the draft (greeting, observation, offer, ask), blank-line separated, as it was written or last edited. pitch_body is this text plus the CTA, signature, and compliance footer assembled in code. Null for rows drafted before the column existed.';
