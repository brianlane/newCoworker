-- Website SEO insights report (BizBlasts Seo::AnalysisService port).
--
-- One stored report per business, refreshed on demand from the dashboard
-- (POST /api/dashboard/seo/analyze): heuristic on-page/local scores over
-- the owner's homepage plus rule-based + AI-written suggestions. Lives on
-- business_configs beside the website knowledge it audits (website_md).

alter table public.business_configs
  add column if not exists seo_report jsonb,
  add column if not exists seo_report_at timestamptz;

comment on column public.business_configs.seo_report is
  'Latest website SEO audit (src/lib/seo/analyze.ts SeoReport shape): factor scores, signals, suggestions. Heuristic only — no live ranking data.';
