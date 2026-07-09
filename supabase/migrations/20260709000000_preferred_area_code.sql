-- Optional signup-chosen area code for the tenant's AI coworker DID.
-- The auto-purchase search tries this first, then the owner-phone-derived
-- NPA, then the platform default (see src/lib/telnyx/did-search-plan.ts).
-- NANP NPAs never start with 0/1, so the check mirrors extractNanpAreaCode.
alter table public.businesses
  add column if not exists preferred_area_code text
  check (preferred_area_code is null or preferred_area_code ~ '^[2-9][0-9]{2}$');

comment on column public.businesses.preferred_area_code is
  'Optional 3-digit NANP area code the owner requested at signup for their AI coworker''s phone number. Highest-priority hint for the auto-purchase DID search; null = derive from owner phone / platform default.';
