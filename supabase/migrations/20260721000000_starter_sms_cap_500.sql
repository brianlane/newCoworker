-- Tier relaunch (Jul 2026), starter margin rescue: trim the Starter monthly
-- SMS cap 750 → 500. Standard stays at 3000.
--
-- Keep in sync with supabase/functions/_shared/sms_monthly_limits.ts
-- (SMS_MONTHLY_CAP_STARTER) — both the Edge reservation path and the app's
-- TIER_LIMITS read that constant, while the Postgres reservation function
-- below is the authority for `try_reserve_sms_outbound_slot`.
--
-- CREATE OR REPLACE resets function config, so the search_path pin from
-- 20260618194956_pin_function_search_path.sql is re-declared inline.
create or replace function public.nonenterprise_monthly_sms_cap(p_tier text)
returns bigint
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select case p_tier
    when 'standard' then 3000::bigint
    else 500::bigint
  end;
$$;
