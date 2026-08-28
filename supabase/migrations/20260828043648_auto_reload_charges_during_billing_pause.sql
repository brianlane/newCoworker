-- DECISION (Brian, 2026-08-28): auto-reload keeps charging during an
-- operator billing pause. Reverts the billing_paused gates added by
-- 20260827224001 (#1688).
--
-- Why: auto-reload is the TENANT'S standing instruction ("when my packs
-- run low, charge my card"), and it buys consumables. The admin pause
-- comps the PLAN FEE (subscription invoices are voided), not consumables.
-- Gating auto-reload on the pause meant a paused tenant's packs drained,
-- their chosen top-up silently never fired, and their calls started
-- refusing: degrading exactly the service the pause promises to keep. An
-- operator who wants a tenant's usage comped too has the explicit levers
-- (comp packs, or the tenant disables auto-reload).
--
-- Both functions below are the pre-gate definitions, restored verbatim
-- from 20260822053831 and 20260822070521.
--
-- -- grants: none (auto_reload_charges_during_billing_pause):
-- create-or-replace of existing functions; the revoke/grant pairs restate
-- the original posture.

create or replace function public.usage_pack_auto_reload_candidates(p_limit integer default 200)
returns table (
  business_id uuid,
  category text,
  pack_id text,
  threshold_units bigint,
  monthly_limit_cents integer,
  cooldown_minutes integer,
  owner_email text,
  business_name text,
  tier text,
  enterprise_limits jsonb,
  phone text,
  timezone text,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_period_start timestamptz,
  stripe_payment_method_id text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    r.business_id,
    r.category,
    r.pack_id,
    r.threshold_units,
    r.monthly_limit_cents,
    r.cooldown_minutes,
    b.owner_email,
    b.name,
    b.tier,
    b.enterprise_limits,
    b.phone,
    b.timezone,
    s.stripe_customer_id,
    s.stripe_subscription_id,
    s.stripe_current_period_start,
    c.stripe_payment_method_id
  from public.usage_pack_auto_reload_rules r
  join public.businesses b on b.id = r.business_id
  join public.subscriptions s on s.business_id = r.business_id
  join public.usage_pack_auto_reload_cards c on c.business_id = r.business_id
  where r.enabled
    and r.paused_at is null
    and c.revoked_at is null
    and s.status = 'active'
    and s.stripe_subscription_id is not null
    -- Cooldown elapsed.
    and (
      r.last_attempt_at is null
      or r.last_attempt_at < now() - make_interval(mins => r.cooldown_minutes)
    )
    -- No fresh in-flight charge. A crashed run leaves the stamp behind, so
    -- it ages out rather than wedging the rule forever.
    and (r.in_flight_at is null or r.in_flight_at < now() - interval '15 minutes')
  order by r.last_attempt_at asc nulls first
  limit greatest(1, coalesce(p_limit, 200));
$$;

create or replace function public.usage_pack_auto_reload_flagged_candidates(
  p_limit integer default 200
)
returns table (
  business_id uuid,
  category text,
  pack_id text,
  threshold_units bigint,
  monthly_limit_cents integer,
  cooldown_minutes integer,
  owner_email text,
  business_name text,
  tier text,
  enterprise_limits jsonb,
  phone text,
  timezone text,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_period_start timestamptz,
  stripe_payment_method_id text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  with claimed as (
    update public.usage_pack_auto_reload_rules r
    set needs_check_at = null
    where (r.business_id, r.category) in (
      select r2.business_id, r2.category
      from public.usage_pack_auto_reload_rules r2
      where r2.needs_check_at is not null
      order by r2.needs_check_at asc
      limit greatest(1, coalesce(p_limit, 200))
      for update skip locked
    )
    returning r.business_id, r.category, r.pack_id, r.threshold_units,
              r.monthly_limit_cents, r.cooldown_minutes, r.enabled, r.paused_at,
              r.last_attempt_at, r.in_flight_at
  )
  select
    c.business_id,
    c.category,
    c.pack_id,
    c.threshold_units,
    c.monthly_limit_cents,
    c.cooldown_minutes,
    b.owner_email,
    b.name,
    b.tier,
    b.enterprise_limits,
    b.phone,
    b.timezone,
    s.stripe_customer_id,
    s.stripe_subscription_id,
    s.stripe_current_period_start,
    cd.stripe_payment_method_id
  from claimed c
  join public.businesses b on b.id = c.business_id
  join public.subscriptions s on s.business_id = c.business_id
  join public.usage_pack_auto_reload_cards cd on cd.business_id = c.business_id
  where c.enabled
    and c.paused_at is null
    and cd.revoked_at is null
    and s.status = 'active'
    and s.stripe_subscription_id is not null
    -- Same cooldown and in-flight guards as the full scan. The fast path must
    -- not become a way around them.
    and (
      c.last_attempt_at is null
      or c.last_attempt_at < now() - make_interval(mins => c.cooldown_minutes)
    )
    and (c.in_flight_at is null or c.in_flight_at < now() - interval '15 minutes');
end;
$$;

revoke execute on function public.usage_pack_auto_reload_candidates(integer) from public;
grant execute on function public.usage_pack_auto_reload_candidates(integer) to service_role;

revoke execute on function public.usage_pack_auto_reload_flagged_candidates(integer) from public;
grant execute on function public.usage_pack_auto_reload_flagged_candidates(integer) to service_role;
