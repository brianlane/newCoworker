-- Adds website knowledge support for the voice + SMS agents.
--
-- `businesses.website_url` stores the raw URL the owner provided at onboarding
-- so the dashboard can re-crawl it; `business_configs.website_md` stores the
-- summarized markdown shipped to /opt/rowboat/vault/website.md on the VPS.
alter table businesses
  add column if not exists website_url text;

alter table business_configs
  add column if not exists website_md text not null default '';
