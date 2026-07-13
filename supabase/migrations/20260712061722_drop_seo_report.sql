-- Remove the Website SEO insights storage (feature removed same-day at the
-- owner's request — reverts #533). The columns only ever held on-demand
-- audit reports; nothing else reads them.

alter table public.business_configs
  drop column if exists seo_report,
  drop column if exists seo_report_at;
