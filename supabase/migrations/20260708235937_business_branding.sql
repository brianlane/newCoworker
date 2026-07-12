-- White-label dashboard branding (enterprise): per-tenant product name,
-- logo, and accent color applied to the dashboard shell. Validated/gated
-- app-side (src/lib/plans/branding.ts + the enterprise tier gate); null =
-- platform default branding.
alter table public.businesses
  add column if not exists branding jsonb;
