-- Voice low-balance alerts: count purchased bonus seconds.
--
-- The three low-balance functions computed headroom as
--   tier_cap - committed_included - in-flight reservations
-- and never read voice_bonus_grants. A tenant sitting on 600 purchased
-- minutes therefore still received "your voice balance is running low"
-- emails, and the email's own advice ("consider purchasing bonus voice
-- seconds") was advice they had already taken.
--
-- Auto-reload makes that self-contradictory rather than merely annoying: we
-- would charge a tenant, top them up, and email them "running low" about the
-- same balance in the same breath. Adding the bonus term makes the alert, the
-- billing page, and the auto-reload trigger agree on one number.
--
-- Bonus grants are not scoped to a Stripe period (they carry across
-- rollover), so the sum is not period-filtered, matching voice_reserve_for_call.
--
-- Live behavior change: pack-holding tenants get fewer low-balance emails.
-- That is the intent.

-- grants: none (voice_bonus_seconds_available): helper, granted below

-- Shared helper so the three call sites cannot drift apart again.
create or replace function public.voice_bonus_seconds_available(p_business_id uuid)
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(sum(g.seconds_remaining), 0)::integer
  from public.voice_bonus_grants g
  where g.business_id = p_business_id
    and g.voided_at is null
    and g.expires_at > now();
$$;

revoke execute on function public.voice_bonus_seconds_available(uuid) from public;
grant execute on function public.voice_bonus_seconds_available(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Claim targets: body identical to 20260420100000 except the bonus term.
-- ---------------------------------------------------------------------------
create or replace function public.voice_claim_low_balance_alert_targets(
  p_threshold_seconds integer default 300
)
returns table (
  business_id uuid,
  owner_email text,
  stripe_period_start timestamptz,
  included_headroom_seconds integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_thr int := greatest(0, p_threshold_seconds);
begin
  return query
  with candidates as (
    select u.business_id, u.stripe_period_start
    from public.voice_billing_period_usage u
    join public.businesses b on b.id = u.business_id
    where u.low_balance_alert_armed
      and b.owner_email is not null
      and length(trim(b.owner_email::text)) > 0
      and (
        u.tier_cap_seconds
        - u.committed_included_seconds
        - coalesce((
            select sum(r.reserved_included_seconds)::int
            from public.voice_reservations r
            where r.business_id = u.business_id
              and r.stripe_period_start_key = u.stripe_period_start
              and r.state in ('pending_answer', 'active')
          ), 0)
        + public.voice_bonus_seconds_available(u.business_id)
      ) < v_thr
    for update of u skip locked
  ),
  claimed as (
    update public.voice_billing_period_usage u
    set low_balance_alert_armed = false,
        updated_at = now()
    from candidates c
    where u.business_id = c.business_id
      and u.stripe_period_start = c.stripe_period_start
    returning u.business_id, u.stripe_period_start, u.tier_cap_seconds, u.committed_included_seconds
  )
  select
    c.business_id,
    b.owner_email::text,
    c.stripe_period_start,
    (
      c.tier_cap_seconds
      - c.committed_included_seconds
      - coalesce((
          select sum(r.reserved_included_seconds)::int
          from public.voice_reservations r
          where r.business_id = c.business_id
            and r.stripe_period_start_key = c.stripe_period_start
            and r.state in ('pending_answer', 'active')
        ), 0)
      + public.voice_bonus_seconds_available(c.business_id)
    )::integer as included_headroom_seconds
  from claimed c
  join public.businesses b on b.id = c.business_id;
end;
$$;

grant execute on function public.voice_claim_low_balance_alert_targets(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Fleet re-arm
-- ---------------------------------------------------------------------------
create or replace function public.voice_sync_low_balance_alert_armed(
  p_threshold_seconds integer default 300
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  n int;
  v_thr int := greatest(0, p_threshold_seconds);
begin
  update public.voice_billing_period_usage u
  set
    low_balance_alert_armed = true,
    updated_at = now()
  from public.businesses b
  where u.business_id = b.id
    and (
      u.tier_cap_seconds
      - u.committed_included_seconds
      - coalesce((
          select sum(r.reserved_included_seconds)::int
          from public.voice_reservations r
          where r.business_id = u.business_id
            and r.stripe_period_start_key = u.stripe_period_start
            and r.state in ('pending_answer', 'active')
        ), 0)
      + public.voice_bonus_seconds_available(u.business_id)
    ) > v_thr;
  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function public.voice_sync_low_balance_alert_armed(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Per-business re-arm (called right after a pack lands)
-- ---------------------------------------------------------------------------
create or replace function public.voice_sync_low_balance_alert_armed_for_business(
  p_business_id uuid,
  p_threshold_seconds integer default 300
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  n int;
  v_thr int := greatest(0, p_threshold_seconds);
begin
  update public.voice_billing_period_usage u
  set
    low_balance_alert_armed = true,
    updated_at = now()
  where u.business_id = p_business_id
    and (
      u.tier_cap_seconds
      - u.committed_included_seconds
      - coalesce((
          select sum(r.reserved_included_seconds)::int
          from public.voice_reservations r
          where r.business_id = u.business_id
            and r.stripe_period_start_key = u.stripe_period_start
            and r.state in ('pending_answer', 'active')
        ), 0)
      + public.voice_bonus_seconds_available(u.business_id)
    ) > v_thr;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.voice_sync_low_balance_alert_armed_for_business(uuid, integer) from public;
grant execute on function public.voice_sync_low_balance_alert_armed_for_business(uuid, integer) to service_role;
