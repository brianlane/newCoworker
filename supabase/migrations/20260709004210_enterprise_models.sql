-- Designated reasoning models + professional voice picker (enterprise).
--
-- Per-tenant overrides for the models the tenant's box runs and the Gemini
-- Live prebuilt voice callers hear. Validated app-side against an allow-list
-- (src/lib/plans/enterprise-models.ts); applied as deploy env at the next
-- provision/redeploy of the tenant VPS. Null = platform defaults.
alter table public.businesses
  add column if not exists enterprise_models jsonb;
