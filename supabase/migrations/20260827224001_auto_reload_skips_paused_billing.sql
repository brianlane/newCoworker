-- Auto-reload must not charge a tenant whose billing an operator paused.
--
-- The pause lever's whole promise is "they keep full service and are not
-- charged", but the candidates function filtered only on status = 'active'
-- (a paused sub deliberately KEEPS that status so dunning/teardown never
-- fire), so the sweep would still charge the tenant's card off-session to
-- backfill packs. One predicate closes it; everything else is the prior
-- definition verbatim.
--
-- -- grants: none (auto_reload_skips_paused_billing): create-or-replace of
-- an existing function; the revoke/grant pair below restates the original
-- posture for self-containment.
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
    -- An operator-paused subscription keeps status 'active' by design (so
    -- dunning and teardown never fire); the pause is its own column, and a
    -- paused tenant must never be charged off-session.
    and s.billing_paused = false
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

revoke execute on function public.usage_pack_auto_reload_candidates(integer) from public;
grant execute on function public.usage_pack_auto_reload_candidates(integer) to service_role;
