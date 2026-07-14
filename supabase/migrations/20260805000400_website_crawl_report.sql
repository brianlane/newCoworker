-- Last-crawl snapshot for the Website Knowledge card: which pages the
-- website-ingest crawl read (url + extracted chars), when, and via which
-- source (direct crawl vs owner-pasted page source). Written by
-- /api/onboard/website-ingest on every successful ingest; NULL until the
-- first ingest after this ships. Service-role-only like the rest of
-- business_configs (RLS posture unchanged by adding a column).
alter table public.business_configs
  add column if not exists website_crawl_report jsonb;
