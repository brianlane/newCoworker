-- Mexico v1: cap customer-facing SMS for Mexican tenants at 100/month on
-- every non-enterprise tier.
--
-- Why: Mexican tenants keep US +1 DIDs (v1), so their texts to +52 terminate
-- as international A2P at the Telnyx list rate of $0.091/part (~5.7x the
-- blended US rate the tiers were priced on; accented Spanish is UCS-2, so a
-- typical message is 2+ parts). The flat Mexican messaging surcharge cannot
-- cover the standard tier's 3,000-message cap ($225-499/mo of worst-case
-- delta), so the cap is the exposure bound, same mechanism as the Jul 2026
-- starter margin rescue (500 -> 100). WhatsApp, whose per-message cost lands
-- on the tenant's own WABA, is the intended volume channel for Mexican
-- customer traffic. Operational owner/platform/compliance texts use
-- meter_operational_sms (never hard-stops), so the coworker can always
-- reach its owner; purchased SMS packs still spill normally past the cap.
--
-- Country classification lives in business_phone_country below: a SQL
-- mirror of businessDefaultPhoneCountry (supabase/functions/_shared/
-- business_country.ts), which itself mirrors resolveBusinessCountry
-- (src/lib/plans/business-country.ts). The worker-integration suite
-- asserts SQL/TS agreement on a fixture matrix, so the three copies
-- cannot drift silently.

-- The US/MX collapse of the business-country rule, for bare-digit and cap
-- decisions: a Mexican-shaped phone (+52 or plus-less 52/521 12/13-digit
-- with a valid 2-9-leading national number) is authoritative MX; any
-- NANP-parseable phone pins US without consulting the timezone; then the
-- Mexican timezone set; anything inconclusive stays US. IMMUTABLE: pure
-- function of its arguments.
create or replace function public.business_phone_country(p_phone text, p_timezone text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  with cleaned as (
    select replace(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '+', '') as digits
  )
  select case
    when (select digits from cleaned) ~ '^52[2-9][0-9]{9}$'
      or (select digits from cleaned) ~ '^521[2-9][0-9]{9}$'
      then 'MX'
    when (select digits from cleaned) ~ '^[2-9][0-9]{2}[2-9][0-9]{6}$'
      or (select digits from cleaned) ~ '^1[2-9][0-9]{2}[2-9][0-9]{6}$'
      then 'US'
    when coalesce(p_timezone, '') in (
      'America/Mexico_City', 'America/Cancun', 'America/Merida',
      'America/Monterrey', 'America/Matamoros', 'America/Chihuahua',
      'America/Ciudad_Juarez', 'America/Ojinaga', 'America/Hermosillo',
      'America/Mazatlan', 'America/Bahia_Banderas', 'America/Tijuana',
      'America/Santa_Isabel', 'America/Ensenada'
    ) then 'MX'
    else 'US'
  end;
$$;

grant execute on function public.business_phone_country(text, text) to service_role;

-- Re-create with the MX minimum. Body identical to 20260613000000_usage_packs
-- except: the row read also fetches phone + timezone, and after the tier cap
-- is resolved, non-enterprise Mexican tenants are clamped to 100/month
-- (enterprise deals negotiate their own MX terms via enterprise_limits).
-- CREATE OR REPLACE resets function config, so the search_path pin from
-- 20260618194956_pin_function_search_path.sql is re-declared inline.
create or replace function public.try_reserve_sms_outbound_slot(p_business_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tier text;
  v_ent jsonb;
  v_phone text;
  v_timezone text;
  v_limit bigint;
  v_used bigint;
  v_today_utc date := (now() at time zone 'utc')::date;
  v_month_start date := date_trunc('month', (now() at time zone 'utc'))::date;
  v_source text := 'plan';
  v_grant_id uuid;
begin
  select b.tier, b.enterprise_limits, b.phone, b.timezone
  into v_tier, v_ent, v_phone, v_timezone
  from public.businesses b
  where b.id = p_business_id
  for update;

  if v_tier is null then
    return jsonb_build_object('ok', false, 'reason', 'no_business');
  end if;

  v_limit := public.monthly_sms_cap_for_business(v_tier, v_ent);

  -- Mexican non-enterprise tenants: clamp to 100/month regardless of tier
  -- (see header). Keep in sync with SMS_MONTHLY_CAP_MX in
  -- supabase/functions/_shared/sms_monthly_limits.ts.
  if v_tier <> 'enterprise'
     and public.business_phone_country(v_phone, v_timezone) = 'MX' then
    v_limit := least(coalesce(v_limit, 100::bigint), 100::bigint);
  end if;

  if v_limit is not null then
    select coalesce(sum(du.sms_sent), 0)::bigint
    into v_used
    from public.daily_usage du
    where du.business_id = p_business_id
      and du.usage_date >= v_month_start;

    if v_used >= v_limit then
      -- Plan cap reached: spill into the purchased bonus balance
      -- (earliest-expiring grant first, matching consume_voice_bonus_seconds).
      update public.sms_bonus_grants g
      set texts_remaining = g.texts_remaining - 1
      where g.id = (
        select g2.id
        from public.sms_bonus_grants g2
        where g2.business_id = p_business_id
          and g2.voided_at is null
          and g2.expires_at > now()
          and g2.texts_remaining > 0
        order by g2.expires_at asc, g2.purchased_at asc
        limit 1
        for update
      )
      returning g.id into v_grant_id;

      if v_grant_id is null then
        return jsonb_build_object('ok', false, 'reason', 'monthly_sms_limit');
      end if;
      v_source := 'bonus';
    end if;
  end if;

  -- Use UTC calendar date (matches v_month_start). Using session-local current_date here
  -- created a subtle drift where a send crossing midnight UTC in a non-UTC session would
  -- write into a daily_usage row not counted in the next-window monthly aggregation.
  insert into public.daily_usage (
    business_id,
    usage_date,
    voice_minutes_used,
    sms_sent,
    calls_made,
    peak_concurrent_calls,
    updated_at
  )
  values (p_business_id, v_today_utc, 0, 1, 0, 0, now())
  on conflict (business_id, usage_date) do update set
    sms_sent = public.daily_usage.sms_sent + 1,
    updated_at = now();

  return jsonb_build_object('ok', true, 'source', v_source);
end;
$$;

grant execute on function public.try_reserve_sms_outbound_slot(uuid) to service_role;
