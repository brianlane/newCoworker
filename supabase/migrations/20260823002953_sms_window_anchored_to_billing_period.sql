-- Anchor the monthly TEXT window to the tenant's Stripe billing period.
--
-- Voice included minutes and the shared AI chat budget already reset on the
-- month-window anchored to `subscriptions.stripe_current_period_start` (see
-- supabase/functions/_shared/billing_period_window.ts). Texts did not: every
-- SMS quota path counted from `date_trunc('month', now())`, the UTC CALENDAR
-- month. A tenant therefore had two different reset days (voice on their
-- anniversary, texts on the 1st) with nothing on the billing page saying so.
--
-- This moves the text window onto the same anchor, so a tenant has ONE reset
-- date across voice, texts, and AI spend.
--
-- Day granularity is forced by the ledger: `daily_usage` is keyed by
-- `usage_date` (a DATE), so a window boundary can only fall on a date. The
-- window start is therefore the DATE of the anchored instant. A tenant whose
-- period starts at 17:30 UTC on the 28th has texts roll over at 00:00 on the
-- 28th and voice at 17:30 the same day; both render as the same date, and no
-- usage row can fall outside both windows.
--
-- Nothing here changes what a tenant is CHARGED. It changes which sends count
-- against the plan allowance in a given window.

-- ---------------------------------------------------------------------------
-- The anchored window start
-- ---------------------------------------------------------------------------
create or replace function public.sms_billing_window_start(p_business_id uuid)
returns date
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_anchor timestamptz;
  v_anchor_utc timestamp;
  v_now_utc timestamp := (now() at time zone 'utc');
  v_n int;
  v_start date;
  -- Changeover date. Every tenant keeps the CALENDAR window they are already
  -- being measured against until their own anniversary next comes round, then
  -- switches to it. Without this, flipping mid-cycle either drags pre-change
  -- usage into the new window (blocking a tenant's texts the instant this
  -- deploys) or drops it (their usage reads as zero and they get a second
  -- allowance). Holding the old window until the anniversary arrives does
  -- neither: the count never jumps, and the first anchored reset lands
  -- exactly on the tenant's own reset date.
  --
  -- Self-retiring: once every tenant has passed one anniversary (at most a
  -- month), no anchored start predates this and the branch is dead. Safe to
  -- delete after 2026-09-30.
  v_changeover constant date := date '2026-08-21';
begin
  select s.stripe_current_period_start
  into v_anchor
  from public.subscriptions s
  where s.business_id = p_business_id
  order by s.created_at desc
  limit 1;

  if v_anchor is null then
    -- No subscription anchor (trial, pre-checkout, wiped): the calendar month
    -- is the only window available, and is what this tenant had before.
    return date_trunc('month', v_now_utc)::date;
  end if;

  v_anchor_utc := (v_anchor at time zone 'utc');

  if v_now_utc <= v_anchor_utc then
    -- Clock skew or a webhook that landed early: window 0.
    v_start := v_anchor_utc::date;
  else
    -- Whole months elapsed. The estimate can only OVERSHOOT around clamped
    -- month ends (a Jan 31 anchor with now = Mar 1 estimates 2, but window 2
    -- is Mar 31), so settle downward onto window[n] <= now < window[n+1].
    -- `+ interval` clamps the day of month exactly like addUtcMonthsClamped
    -- in _shared/billing_period_window.ts: Jan 31 + 1 month = Feb 28.
    v_n := greatest(
      0,
      ((date_part('year', v_now_utc) - date_part('year', v_anchor_utc)) * 12
        + (date_part('month', v_now_utc) - date_part('month', v_anchor_utc)))::int
    );
    while v_n > 0 and (v_anchor_utc + make_interval(months => v_n)) > v_now_utc loop
      v_n := v_n - 1;
    end loop;
    v_start := (v_anchor_utc + make_interval(months => v_n))::date;
  end if;

  if v_start < v_changeover then
    return date_trunc('month', v_now_utc)::date;
  end if;

  return v_start;
end;
$function$;

grant execute on function public.sms_billing_window_start(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Window usage, summed server-side
-- ---------------------------------------------------------------------------
-- The app used to select the tenant's `daily_usage` rows and sum them in TS
-- against its own calendar-month start. Summing here instead means the number
-- the billing page displays is produced by the same expression the reserve RPC
-- enforces with, so display and enforcement cannot drift apart.
create or replace function public.sms_billing_window_usage(p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_start date := public.sms_billing_window_start(p_business_id);
  v_sms bigint;
  v_units numeric;
  v_calls bigint;
begin
  select
    coalesce(sum(du.sms_sent), 0)::bigint,
    coalesce(sum(du.sms_text_units), 0),
    coalesce(sum(du.calls_made), 0)::bigint
  into v_sms, v_units, v_calls
  from public.daily_usage du
  where du.business_id = p_business_id
    and du.usage_date >= v_start;

  return jsonb_build_object(
    'window_start', v_start,
    'sms_sent', v_sms,
    'sms_text_units', v_units,
    'calls_made', v_calls
  );
end;
$function$;

grant execute on function public.sms_billing_window_usage(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Enforcement paths, re-pointed at the anchored window
-- ---------------------------------------------------------------------------
-- Each body below is the CURRENT definition with only the window line changed
-- (plus `window_start` added to the returned JSON, so a caller can key its
-- once-per-period cap alert off the same window the meter used instead of
-- recomputing a calendar month).

-- check_sms_monthly_limit
CREATE OR REPLACE FUNCTION public.check_sms_monthly_limit(p_business_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_tier text;
  v_ent jsonb;
  v_limit bigint;
  v_used bigint;
  v_month_start date;
begin
  select b.tier, b.enterprise_limits
  into v_tier, v_ent
  from public.businesses b
  where b.id = p_business_id;

  if v_tier is null then
    return jsonb_build_object('allowed', false, 'reason', 'no_business');
  end if;

  v_limit := public.monthly_sms_cap_for_business(v_tier, v_ent);

  if v_limit is null then
    return jsonb_build_object('allowed', true);
  end if;

  v_month_start := public.sms_billing_window_start(p_business_id);

  select coalesce(sum(du.sms_sent), 0)::bigint
  into v_used
  from public.daily_usage du
  where du.business_id = p_business_id
    and du.usage_date >= v_month_start;

  if v_used >= v_limit then
    return jsonb_build_object('allowed', false, 'reason', 'monthly_sms_limit');
  end if;

  return jsonb_build_object('allowed', true);
end;
$function$
;

-- meter_sms_operational_send
CREATE OR REPLACE FUNCTION public.meter_sms_operational_send(p_business_id uuid, p_text_units numeric DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_tier text;
  v_ent jsonb;
  v_limit bigint;
  v_used numeric;
  v_units numeric := greatest(1, coalesce(p_text_units, 1));
  v_units_int int := greatest(1, round(greatest(1, coalesce(p_text_units, 1)))::int);
  v_today_utc date := (now() at time zone 'utc')::date;
  v_month_start date := public.sms_billing_window_start(p_business_id);
  v_source text := 'plan';
  v_grant_id uuid;
begin
  select b.tier, b.enterprise_limits
  into v_tier, v_ent
  from public.businesses b
  where b.id = p_business_id
  for update;

  if v_tier is null then
    -- Unknown business: nothing to meter against; report instead of failing
    -- the (possibly legally required) send.
    return jsonb_build_object('counted', false, 'reason', 'no_business');
  end if;

  v_limit := public.monthly_sms_cap_for_business(v_tier, v_ent);

  if v_limit is not null then
    select coalesce(sum(du.sms_text_units), 0)
    into v_used
    from public.daily_usage du
    where du.business_id = p_business_id
      and du.usage_date >= v_month_start;

    if v_used >= v_limit then
      -- Same spill order as try_reserve_sms_outbound_slot: purchased bonus
      -- texts first (earliest-expiring grant)...
      update public.sms_bonus_grants g
      set texts_remaining = greatest(0, g.texts_remaining - v_units_int)
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

      -- ...but with no bonus left the send STILL counts (visible overage in
      -- the ledger) instead of being refused; that is the whole point of
      -- the operational meter.
      v_source := case when v_grant_id is not null then 'bonus' else 'overage' end;
    end if;
  end if;

  -- Identical increment shape to try_reserve_sms_outbound_slot (UTC date,
  -- same ledger row) so plan/bonus/overage all read out of one number.
  insert into public.daily_usage (
    business_id,
    usage_date,
    voice_minutes_used,
    sms_sent,
    sms_text_units,
    calls_made,
    peak_concurrent_calls,
    updated_at
  )
  values (p_business_id, v_today_utc, 0, 1, v_units, 0, 0, now())
  on conflict (business_id, usage_date) do update set
    sms_sent = public.daily_usage.sms_sent + 1,
    sms_text_units = public.daily_usage.sms_text_units + excluded.sms_text_units,
    updated_at = now();

  return jsonb_build_object(
    'counted', true,
    'source', v_source,
    -- Window the send was metered against. Callers thread this straight
    -- into the once-per-period cap-alert key so the alert dedupe and the
    -- meter can never disagree about which window they are in.
    'window_start', v_month_start
  );
end;
$function$
;

-- try_reserve_sms_outbound_slot
CREATE OR REPLACE FUNCTION public.try_reserve_sms_outbound_slot(p_business_id uuid, p_text_units numeric DEFAULT 1, p_destination_e164 text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_tier text;
  v_ent jsonb;
  v_phone text;
  v_timezone text;
  v_limit bigint;
  v_used numeric;
  v_units numeric := greatest(1, coalesce(p_text_units, 1));
  -- Bonus grants are integer texts; round the units for grant arithmetic
  -- (a 2.2-unit MMS consumes 2 bonus texts).
  v_units_int int := greatest(1, round(greatest(1, coalesce(p_text_units, 1)))::int);
  v_today_utc date := (now() at time zone 'utc')::date;
  v_month_start date := public.sms_billing_window_start(p_business_id);
  v_source text := 'plan';
  v_grant_id uuid;
  v_dest_country text;
  v_new_country boolean := false;
  -- Satellite / international-premium number ranges (no ISO country) are
  -- unroutable by the country table and refuse as 'destination_unknown'.
  -- This list refuses countries that DO resolve but are classic toll-fraud
  -- or embargo-priced destinations: Cuba, North Korea, Somalia, Sierra
  -- Leone, Guinea, Guinea-Bissau, Sao Tome. Widen deliberately, never by
  -- accident.
  v_denylist text[] := array['CU', 'KP', 'SO', 'SL', 'GN', 'GW', 'ST'];
begin
  -- Destination gate (only when the caller passes the destination; the
  -- default keeps mid-deploy callers and tests ungated).
  if p_destination_e164 is not null then
    v_dest_country := public.sms_destination_country(p_destination_e164);
    if v_dest_country is null then
      -- Default-closed: a prefix we cannot attribute to a country (includes
      -- satellite +881/+882/+883 and premium +979 ranges) never sends.
      return jsonb_build_object('ok', false, 'reason', 'destination_unknown');
    end if;
    if v_dest_country = any (v_denylist) then
      return jsonb_build_object('ok', false, 'reason', 'destination_blocked');
    end if;
    if v_dest_country not in ('US', 'CA') then
      -- Rolling-hour velocity brake per (tenant, country): slows an
      -- SMS-pumping burst enough for the first-country alert and the
      -- monthly cap to matter. Domestic traffic is exempt.
      if (
        select count(*)
        from public.sms_destination_events e
        where e.business_id = p_business_id
          and e.country = v_dest_country
          and e.sent_at > now() - interval '1 hour'
      ) >= 20 then
        return jsonb_build_object(
          'ok', false,
          'reason', 'destination_velocity',
          'destination_country', v_dest_country
        );
      end if;
      if v_dest_country <> 'MX' then
        v_new_country := not exists (
          select 1
          from public.sms_destination_events e
          where e.business_id = p_business_id
            and e.country = v_dest_country
        );
      end if;
      -- The event insert and the first-country alert are deferred to just
      -- before the SUCCESS return: a normal (non-raising) plpgsql return
      -- COMMITS earlier writes, so recording here would let cap-refused or
      -- no-business reserves inflate velocity counts and fire false
      -- first-country alerts for sends that never happened.
    end if;
  end if;

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
  -- (units; see the weighted_sms_metering migration). Keep in sync with
  -- SMS_MONTHLY_CAP_MX in supabase/functions/_shared/sms_monthly_limits.ts.
  if v_tier <> 'enterprise'
     and public.business_phone_country(v_phone, v_timezone) = 'MX' then
    v_limit := least(coalesce(v_limit, 100::bigint), 100::bigint);
  end if;

  if v_limit is not null then
    select coalesce(sum(du.sms_text_units), 0)
    into v_used
    from public.daily_usage du
    where du.business_id = p_business_id
      and du.usage_date >= v_month_start;

    if v_used >= v_limit then
      -- Plan cap reached: spill into the purchased bonus balance
      -- (earliest-expiring grant first, matching consume_voice_bonus_seconds).
      -- greatest(0, ...) because one grant may hold fewer texts than this
      -- message's units; the shortfall (at most units-1 texts, only on the
      -- exhausting send) is absorbed rather than split across grants.
      update public.sms_bonus_grants g
      set texts_remaining = greatest(0, g.texts_remaining - v_units_int)
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
        return jsonb_build_object(
          'ok', false,
          'reason', 'monthly_sms_limit',
          'window_start', v_month_start
        );
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
    sms_text_units,
    calls_made,
    peak_concurrent_calls,
    updated_at
  )
  values (p_business_id, v_today_utc, 0, 1, v_units, 0, 0, now())
  on conflict (business_id, usage_date) do update set
    sms_sent = public.daily_usage.sms_sent + 1,
    sms_text_units = public.daily_usage.sms_text_units + excluded.sms_text_units,
    updated_at = now();

  -- Record the destination history ONLY for a reserve that succeeded (see
  -- the gate block above for why not earlier). Domestic US/CA traffic is
  -- never recorded; the table exists for the velocity brake and the
  -- first-country alert, both international-only.
  if v_dest_country is not null and v_dest_country not in ('US', 'CA') then
    insert into public.sms_destination_events (business_id, country)
    values (p_business_id, v_dest_country);
    -- Operator alert, written HERE so every caller is covered by one site:
    -- a tenant's first send to a new international country lands in the
    -- admin system-log feed (warn level). SMS-pumping abuse looks exactly
    -- like this the moment it starts.
    if v_new_country then
      insert into public.system_logs (business_id, source, level, event, message, payload)
      values (
        p_business_id,
        'sms_meter',
        'warn',
        'sms_first_send_to_country',
        'First outbound SMS to a new destination country: ' || v_dest_country,
        jsonb_build_object('country', v_dest_country)
      );
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'source', v_source,
    'destination_country', v_dest_country,
    'new_destination_country', v_new_country,
    'window_start', v_month_start
  );
end;
$function$
;

-- Re-grant: `create or replace` keeps existing grants, but the three above are
-- called through PostgREST and the fn_grants_lockdown event trigger strips
-- non-service_role EXECUTE, so state them explicitly rather than inheriting.
grant execute on function public.check_sms_monthly_limit(uuid) to service_role;
grant execute on function public.meter_sms_operational_send(uuid, numeric) to service_role;
grant execute on function public.try_reserve_sms_outbound_slot(uuid, numeric, text) to service_role;
