-- ---------------------------------------------------------------------------
-- Prospecting: keep the Places signals we are already paying for.
--
-- The discovery field mask requests `websiteUri` and `nationalPhoneNumber`,
-- which Google bills in the Text Search ENTERPRISE tier. Requests are billed at
-- the highest tier among the fields asked for, so every field in that same
-- tier is free to add: opening hours, rating, and review count cost nothing
-- extra per query and were simply being left on the table.
--
--   google_hours  - `places.regularOpeningHours` verbatim. Replaces regex-
--                   scraping hours out of the prospect's HTML for the
--                   after-hours and weekend findings, which silently found
--                   nothing on any site that renders its hours in JavaScript.
--   rating /      - orders which prospects get probed and drafted first. An
--   review_count    established business with hundreds of reviews is worth a
--                   draft before a listing with two. Deliberately NOT a
--                   filter: a low review count is not evidence of anything,
--                   and excluding on it would quietly narrow the market.
-- ---------------------------------------------------------------------------

alter table public.outreach_prospects
  add column if not exists google_hours jsonb,
  add column if not exists rating numeric(2, 1),
  add column if not exists review_count integer;

-- The probe/draft scan: newest-first within a business, busiest first.
create index if not exists idx_outreach_prospects_probe_order
  on public.outreach_prospects (business_id, status, review_count desc nulls last);

comment on column public.outreach_prospects.google_hours is
  'places.regularOpeningHours as returned by Places Text Search (New). Source of the after-hours and closed-weekend findings when present; the site HTML is the fallback. Free to collect: same Enterprise field tier as websiteUri, which the mask already requests.';
comment on column public.outreach_prospects.rating is
  'Google rating at discovery. Orders the probe/draft queue only, never filters: a low or missing rating is not evidence a business would not want this.';
comment on column public.outreach_prospects.review_count is
  'places.userRatingCount at discovery. Orders the probe/draft queue so established businesses are drafted first.';

-- grants: none (columns inherit the table grants from 20260821202816).
