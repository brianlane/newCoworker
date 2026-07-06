-- Starter rebalance (Jul 2026): trim the Starter monthly SMS cap 500 → 100.
-- At the blended ~$0.0159/msg Telnyx rate this caps worst-case SMS exposure
-- at ~$1.59/mo, which (with the $5 AI budget and 25 included voice minutes)
-- keeps a full-cap starter tenant profitable even on the monthly KVM1 SKU.
-- Standard stays at 3000.
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
    else 100::bigint
  end;
$$;
