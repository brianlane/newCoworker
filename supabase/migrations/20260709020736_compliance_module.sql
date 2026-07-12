-- Custom compliance modules (enterprise): per-tenant guardrail text +
-- restricted-term list layered ON TOP of the platform guardrails (never
-- replacing them). Validated app-side (src/lib/compliance/fha.ts); the admin
-- save also rewrites the marker-delimited section inside
-- business_configs.soul_md and schedules a vault sync so live boxes pick the
-- change up without a redeploy. Null = platform guardrails only.
alter table public.businesses
  add column if not exists compliance_module jsonb;
