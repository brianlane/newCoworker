-- Meter EVERY outbound SMS, including platform/owner/compliance traffic.
--
-- Policy change (Jul 14 2026, Brian): the README's "intentional operational
-- exemptions" — owner alerts, AiFlow owner notices, the provisioning
-- "your Coworker is live" text, teammate acks, Safe-Mode forwards, and
-- STOP/HELP/START compliance replies — previously did not touch the
-- tenant's monthly SMS pool at all. Nothing is exempt from METERING now:
-- every send increments the same `daily_usage.sms_sent` ledger the
-- dashboard quota UI reads and spills into purchased bonus texts exactly
-- like customer traffic.
--
-- What deliberately does NOT change: these operational sends are still
-- never REFUSED. STOP/HELP/START replies are legally required; owner
-- alerts include the "you hit your SMS cap" alert itself (hard-stopping it
-- on the very cap it reports would self-lock); Safe-Mode forwards exist so
-- a paused AI never silently eats customer texts. So this RPC counts —
-- plan slot, else bonus text, else explicit OVERAGE past the cap — and
-- always succeeds. Customer-facing sends keep using
-- try_reserve_sms_outbound_slot (hard stop at the cap) unchanged.
create or replace function public.meter_sms_operational_send(p_business_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tier text;
  v_ent jsonb;
  v_limit bigint;
  v_used bigint;
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
    select coalesce(sum(du.sms_sent), 0)::bigint
    into v_used
    from public.daily_usage du
    where du.business_id = p_business_id
      and du.usage_date >= v_month_start;

    if v_used >= v_limit then
      -- Same spill order as try_reserve_sms_outbound_slot: purchased bonus
      -- texts first (earliest-expiring grant)…
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

      -- …but with no bonus left the send STILL counts (visible overage in
      -- the ledger) instead of being refused — that is the whole point of
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
    calls_made,
    peak_concurrent_calls,
    updated_at
  )
  values (p_business_id, v_today_utc, 0, 1, 0, 0, now())
  on conflict (business_id, usage_date) do update set
    sms_sent = public.daily_usage.sms_sent + 1,
    updated_at = now();

  return jsonb_build_object('counted', true, 'source', v_source);
end;
$$;

comment on function public.meter_sms_operational_send is
  'Count one operational (owner/platform/compliance) outbound SMS against the tenant''s monthly pool — plan, bonus spill, or explicit overage — WITHOUT ever refusing. Customer-facing sends use try_reserve_sms_outbound_slot (hard stop) instead.';

revoke all on function public.meter_sms_operational_send(uuid) from public;
grant execute on function public.meter_sms_operational_send(uuid) to service_role;
