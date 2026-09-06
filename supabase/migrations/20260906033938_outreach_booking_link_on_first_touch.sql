-- The first cold email asks; it does not book.
--
-- Every first-touch pitch has carried the booking link as its CTA ("You can
-- grab a time here: ..."). Outbound Prospecting's read (Sep 2026) is that
-- asking a stranger to pick a calendar slot in the first email is what has
-- been costing replies: the mail should end on a soft yes/no ask and earn the
-- link on a later touch. So the link on the FIRST email becomes a choice.
--
-- Two knobs, both read by assembleBody in code (never by a model):
--
--   outreach_settings.booking_link_on_first_touch   the tenant's default.
--     false (the new default) ends the first email with "Just reply if you
--     want to hear more." and keeps the sign-off, unsubscribe link, and
--     postal address exactly as before. true restores the old behavior.
--     The follow-up nudge is unaffected: it carries the link whenever the
--     tenant has one, because by then the prospect has heard from us once.
--
--   outreach_prospects.include_booking_link          a per-draft override.
--     null follows the tenant default. true/false is what a connector
--     (upsert_outreach_prospect / update_outreach_draft) or a later owner
--     surface chose for this one prospect, and it survives edits and
--     "Write it again" so the choice cannot be silently undone by a re-save.
--
-- Default false rather than true: the one tenant with outreach on (HQ) is the
-- tenant asking for the change, and a new tenant should start from the copy
-- that reads like a person rather than a funnel. Drafts already assembled
-- keep their stored body; scripts/oneshot/reassemble-outreach-drafts.ts
-- rebuilds waiting drafts under the new rule.
alter table public.outreach_settings
  add column if not exists booking_link_on_first_touch boolean not null default false;

comment on column public.outreach_settings.booking_link_on_first_touch is
  'Whether the FIRST cold email carries the booking link as its CTA. False ends it on a reply ask; the follow-up always carries the link when one exists.';

alter table public.outreach_prospects
  add column if not exists include_booking_link boolean;

comment on column public.outreach_prospects.include_booking_link is
  'Per-draft override of outreach_settings.booking_link_on_first_touch. Null follows the tenant default.';

-- grants: none (outreach_settings, outreach_prospects): existing tables,
-- already granted; this adds columns, not objects.
