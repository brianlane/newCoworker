-- Mirror a subscription's recurring membership pack add-ons onto the local row.
--
-- The packs a tenant carries live only in Stripe subscription metadata
-- (addonVoice / addonSms / addonChat). Nothing server-rendered could see them,
-- so the dashboard's change-plan selector started empty on every render. Since
-- change-plan cancels the old Stripe subscription and rebuilds from the
-- selector's lines alone, a tenant switching annual to biennial without
-- touching the pack steppers silently lost their packs from the next invoice,
-- with no warning and no line in the confirm sheet.
--
-- Shape: exactly the three metadata keys, so parseMembershipPackAddonMetadata
-- reads this column unchanged and there is one encoding, not two. Null means
-- "no packs" (or a row Stripe has not mirrored yet).
--
-- Stripe stays the source of truth: this is a read cache written by the
-- customer.subscription.created/updated mirror, which is the one place that
-- already runs on signup activation, change-plan, and any Stripe-side edit.
--
-- grants: none (column on an existing table; subscriptions already carries its
-- service_role grants from 20260325140000_init.sql).

alter table public.subscriptions
  add column if not exists membership_pack_addons jsonb;

comment on column public.subscriptions.membership_pack_addons is
  'Read cache of Stripe subscription metadata addonVoice/addonSms/addonChat. Stripe is authoritative; written by the customer.subscription mirror.';
