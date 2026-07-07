-- Emailable payment links + pre-account (prospect) custom white-glove offers.
--
-- 1. business_id becomes NULLABLE: an admin can author an offer for a
--    PROSPECT who has no account yet. recipient_email records who the deal
--    is for (and pre-fills Stripe Checkout); the check constraint keeps
--    every offer addressed to a business OR an email, never neither.
-- 2. pay_token is an unguessable capability for the PUBLIC payment link
--    (/offer/<pay_token>): visiting it creates a fresh Stripe Checkout
--    Session for the stored amount, so the admin can email one durable URL
--    instead of a Checkout session that expires in 24h.
alter table public.white_glove_offers
  alter column business_id drop not null,
  add column if not exists recipient_email text
    check (recipient_email is null or char_length(recipient_email) <= 320),
  add column if not exists pay_token uuid not null default gen_random_uuid();

alter table public.white_glove_offers
  drop constraint if exists white_glove_offers_addressee_check;
alter table public.white_glove_offers
  add constraint white_glove_offers_addressee_check
    check (business_id is not null or recipient_email is not null);

create unique index if not exists white_glove_offers_pay_token_idx
  on public.white_glove_offers (pay_token);
