-- Weighted SMS metering: cap on billable text units (parts), not messages.
--
-- Why: Telnyx bills SMS per PART (160 GSM-7 chars, 70 UCS-2) and the fleet
-- averages 2.5 parts per message with 3.8% of traffic at the 10-part ceiling,
-- so the old message-denominated cap admitted ~5x the SMS spend the pricing
-- model assumes (3,000 ten-part messages cost $255 against the ~$47.70 the
-- tier-economics canvas prices standard against). MMS bills as one unit per
-- message regardless of media size, measured at ~2.2x the blended per-part
-- SMS cost, so an MMS reserves 2.2 units.
--
-- What changes:
--   * daily_usage.sms_text_units (numeric): the enforced ledger. Backfilled
--     from sms_sent so no tenant is retroactively over cap. sms_sent keeps
--     meaning MESSAGES and keeps feeding analytics/billing displays.
--   * nonenterprise_monthly_sms_cap re-denominated in units: starter 100
--     messages -> 150 units, standard 3,000 messages -> 5,000 units. Both
--     hold the canvas worst-case dollars ($1.32 vs planned $1.59 starter,
--     $43.94 vs planned $47.70 standard at the measured $0.008787/part).
--   * try_reserve_sms_outbound_slot / meter_sms_operational_send /
--     release_sms_outbound_slot gain p_text_units (default 1), so existing
--     callers keep working while the senders migrate. Bonus grants
--     (integer texts) consume/refund round(p_text_units).
--   * The MX tenant clamp stays 100, now denominated in units (tighter:
--     ~40 average messages). Deliberate: the clamp bounds $0.091/part
--     exposure, and Phase 2's destination multipliers will revisit it.
--
-- Semantics kept from the previous versions, on purpose:
--   * Check-then-increment: a message that STARTS under the cap counts on
--     plan even if it crosses it (overshoot bounded by one message's units,
--     max 10 parts ~= $0.09).
--   * Cap window is the UTC calendar month; ledger row is per UTC day.
--   * Operational sends are metered but never refused.
--   * The auto-reload fast-path trigger watches UPDATE OF sms_sent; every
--     write below updates sms_sent and sms_text_units in the SAME statement,
--     so the stamp still fires.
-- CREATE OR REPLACE resets function config, so the search_path pin from
-- 20260618194956_pin_function_search_path.sql is re-declared inline.

-- ---------------------------------------------------------------------------
-- Ledger column
-- ---------------------------------------------------------------------------
alter table public.daily_usage
  add column if not exists sms_text_units numeric not null default 0;

comment on column public.daily_usage.sms_text_units is
  'Billable text units consumed by outbound SMS/MMS (SMS: one per part; MMS: 2.2). The monthly cap is enforced against sum(sms_text_units); sms_sent stays a message count for analytics.';

-- Backfill: treat history as 1 unit per message so current-month usage does
-- not jump on deploy and nobody lands retroactively over the new cap.
update public.daily_usage
set sms_text_units = sms_sent
where sms_text_units = 0
  and sms_sent > 0;

-- ---------------------------------------------------------------------------
-- Tier caps, re-denominated in units (starter 150, standard 5,000)
-- ---------------------------------------------------------------------------
create or replace function public.nonenterprise_monthly_sms_cap(p_tier text)
returns bigint
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_tier
    when 'standard' then 5000::bigint
    else 150::bigint
  end;
$$;

-- Keep in sync with SMS_MONTHLY_CAP_STARTER / SMS_MONTHLY_CAP_STANDARD in
-- supabase/functions/_shared/sms_monthly_limits.ts.

-- ---------------------------------------------------------------------------
-- Reserve (customer-facing, hard stop at the cap)
-- ---------------------------------------------------------------------------
-- Signature change (uuid) -> (uuid, numeric default 1) requires an explicit
-- drop; existing one-arg callers keep working through the default.
drop function if exists public.try_reserve_sms_outbound_slot(uuid);

create or replace function public.try_reserve_sms_outbound_slot(
  p_business_id uuid,
  p_text_units numeric default 1
)
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
  v_used numeric;
  v_units numeric := greatest(1, coalesce(p_text_units, 1));
  -- Bonus grants are integer texts; round the units for grant arithmetic
  -- (a 2.2-unit MMS consumes 2 bonus texts).
  v_units_int int := greatest(1, round(greatest(1, coalesce(p_text_units, 1)))::int);
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
  -- (now units; see header). Keep in sync with SMS_MONTHLY_CAP_MX in
  -- supabase/functions/_shared/sms_monthly_limits.ts.
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

  return jsonb_build_object('ok', true, 'source', v_source);
end;
$$;

revoke all on function public.try_reserve_sms_outbound_slot(uuid, numeric) from public;
grant execute on function public.try_reserve_sms_outbound_slot(uuid, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- Operational meter (owner/platform/compliance, counts but never refuses)
-- ---------------------------------------------------------------------------
drop function if exists public.meter_sms_operational_send(uuid);

create or replace function public.meter_sms_operational_send(
  p_business_id uuid,
  p_text_units numeric default 1
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tier text;
  v_ent jsonb;
  v_limit bigint;
  v_used numeric;
  v_units numeric := greatest(1, coalesce(p_text_units, 1));
  v_units_int int := greatest(1, round(greatest(1, coalesce(p_text_units, 1)))::int);
  v_today_utc date := (now() at time zone 'utc')::date;
  v_month_start date := date_trunc('month', (now() at time zone 'utc'))::date;
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

  return jsonb_build_object('counted', true, 'source', v_source);
end;
$$;

comment on function public.meter_sms_operational_send is
  'Count one operational (owner/platform/compliance) outbound SMS against the tenant''s monthly pool in text units (plan, bonus spill, or explicit overage) WITHOUT ever refusing. Customer-facing sends use try_reserve_sms_outbound_slot (hard stop) instead.';

revoke all on function public.meter_sms_operational_send(uuid, numeric) from public;
grant execute on function public.meter_sms_operational_send(uuid, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- Release: undo the matching reserve (message + units, optional bonus refund)
-- ---------------------------------------------------------------------------
drop function if exists public.release_sms_outbound_slot(uuid, boolean);

create or replace function public.release_sms_outbound_slot(
  p_business_id uuid,
  p_refund_bonus boolean default false,
  p_text_units numeric default 1
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_units numeric := greatest(1, coalesce(p_text_units, 1));
  v_units_int int := greatest(1, round(greatest(1, coalesce(p_text_units, 1)))::int);
  v_today_utc date := (now() at time zone 'utc')::date;
  v_updated int;
begin
  update public.daily_usage du
  set
    sms_sent = greatest(0, du.sms_sent - 1),
    sms_text_units = greatest(0, du.sms_text_units - v_units),
    updated_at = now()
  where du.business_id = p_business_id
    and du.usage_date = v_today_utc
    and du.sms_sent > 0;
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    update public.daily_usage du
    set
      sms_sent = greatest(0, du.sms_sent - 1),
      sms_text_units = greatest(0, du.sms_text_units - v_units),
      updated_at = now()
    where du.ctid = (
      select ctid
      from public.daily_usage
      where business_id = p_business_id
        and sms_sent > 0
        and usage_date >= v_today_utc - interval '2 days'
      order by usage_date desc
      limit 1
      for update
    );
  end if;

  -- Refund the bonus texts the failed send consumed. We can't know the exact
  -- grant the reserve debited, so credit the earliest-expiring active grant,
  -- the same one the NEXT reserve would debit, so balances stay correct in
  -- aggregate. If every grant expired/voided in between, the refund is
  -- dropped (acceptable: a few texts on an already-dead grant).
  if p_refund_bonus then
    update public.sms_bonus_grants g
    set texts_remaining = least(g.texts_purchased, g.texts_remaining + v_units_int)
    where g.id = (
      select g2.id
      from public.sms_bonus_grants g2
      where g2.business_id = p_business_id
        and g2.voided_at is null
        and g2.expires_at > now()
      order by g2.expires_at asc, g2.purchased_at asc
      limit 1
      for update
    );
  end if;
end;
$$;

revoke all on function public.release_sms_outbound_slot(uuid, boolean, numeric) from public;
grant execute on function public.release_sms_outbound_slot(uuid, boolean, numeric) to service_role;
