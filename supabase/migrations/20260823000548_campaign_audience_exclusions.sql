-- Campaign audiences gain two subtractions: a tag to leave OUT, and a
-- default exclusion of customers who already closed.
--
-- Until now an audience was one addition (`audience_tag`, blank meaning
-- everyone) with no way to say "everyone EXCEPT". Two things made that thin:
--
--   * The obvious send, a broadcast to the whole directory, had no way to
--     spare a group. "Everyone except the people I just onboarded" needed a
--     throwaway tag on every other contact.
--   * Since the meeting-minutes classifier landed, the platform WRITES the
--     Won stage tag itself, so the closed-customer group now grows without
--     anyone touching the board. An owner who never thinks about it would
--     quietly start mailing more and more of their existing customers.
--
-- `include_closed` defaults FALSE, so the safe reading is the default: a
-- campaign leaves closed customers alone unless the owner ticks the box.
-- That deliberately narrows any draft that already exists, which is the
-- right direction for marketing mail (fewer sends to people who already
-- bought), and the composer's live recipient count shows the effect before
-- anything is scheduled.
--
-- "Closed" is resolved against the tenant's OWN board rather than a
-- hardcoded name: a contact is closed when their stage is at or past the
-- stage the platform writes for a won deal, so a board with columns after
-- Won (Onboarded, Active) counts those too. See src/lib/campaigns/filter.ts.
--
-- grants: none (campaign_audience_exclusions): no object is CREATED here.
-- Both statements are `alter table` against public.email_campaigns, whose
-- service-role grants were issued in 20260811173000_email_campaigns.sql and
-- continue to cover new columns.

alter table public.email_campaigns
  add column if not exists exclude_tag text not null default '';

alter table public.email_campaigns
  add column if not exists include_closed boolean not null default false;

comment on column public.email_campaigns.exclude_tag is
  'Contact tag to leave OUT of the audience, matched case-insensitively like audience_tag. Blank = subtract nothing. Applied after audience_tag, so a contact carrying both is excluded.';

comment on column public.email_campaigns.include_closed is
  'False (the default) leaves out contacts whose pipeline stage is at or past the won stage, so a broadcast does not mail people who already bought. True includes them, which is what an onboarding or upsell campaign wants.';
