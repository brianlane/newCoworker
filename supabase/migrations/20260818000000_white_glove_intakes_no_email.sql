-- White-glove intakes: admin-side creation without an email, and
-- de-duplication with the onboarding interview.
--
-- 1. recipient_email becomes NULLABLE: an admin can generate a questionnaire
--    link with just a name/business and share it however they like (or fill
--    it out with the prospect on a call). The existing length CHECK already
--    passes on NULL.
-- 2. business_name + industry move OFF the questionnaire and onto the row:
--    the onboarding interview (Step 1 form + chat) already collects business
--    name, industry/business type, website, and tone — the prospect should
--    never answer them twice. The admin supplies name (+ optional industry,
--    which drives the questionnaire's suggested wording) at create time.
--
-- Defaults exist only so the ALTER succeeds on any pre-existing rows; the
-- app always supplies business_name and validates it non-empty.
alter table public.white_glove_intakes
  alter column recipient_email drop not null,
  add column if not exists business_name text not null default ''
    check (char_length(business_name) <= 200),
  add column if not exists industry text not null default 'other'
    check (char_length(industry) <= 40);
