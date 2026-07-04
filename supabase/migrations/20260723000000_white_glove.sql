-- White-glove onboarding packages (fleet economics plan, Phase C5).
--
-- Two one-time Stripe purchases ('setup' $750 / 'buildout' $2,000) recorded
-- by the Stripe webhook on checkout.session.completed with
-- metadata.checkoutKind = 'white_glove_package'. Either purchase opens a
-- 30-day priority call/video support window; without it, Starter/Standard
-- support is email-only. Catalog + helpers: src/lib/plans/white-glove.ts.

alter table businesses
  add column if not exists white_glove_package text
    check (white_glove_package is null or white_glove_package in ('setup', 'buildout')),
  add column if not exists white_glove_purchased_at timestamptz,
  add column if not exists priority_support_until timestamptz;

comment on column businesses.white_glove_package is
  'Highest white-glove onboarding package purchased (setup|buildout). NULL = none.';
comment on column businesses.white_glove_purchased_at is
  'When the (latest) white-glove package checkout completed.';
comment on column businesses.priority_support_until is
  'Priority call/video support window end (purchase + 30d). NULL/past = email-only support.';
