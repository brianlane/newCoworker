-- Fleet-wide outbound concurrency gate (pre-dial), part 2 of the Telnyx
-- capacity plan.
--
-- The Telnyx account allows N concurrent outbound calls ACROSS the fleet,
-- while every concurrency check in the platform is scoped to one business_id
-- (per-tenant caps of 10 sum far past the account pool of 10). This migration
-- gives the pre-dial probe a platform-wide view:
--
--  1. voice_reservations.direction: reservations are minted for INBOUND and
--     OUTBOUND calls alike, but only outbound legs consume the Telnyx
--     outbound channel pool. The column defaults to 'inbound'; originate
--     stamps 'outbound' right after the post-dial reserve. Counting from
--     reservations (not voice_active_sessions) is deliberate: a ringing leg
--     holds a channel and has a pending_answer reservation within ~1s of the
--     dial, while active-session rows only exist once media attaches (and
--     reach B legs never get one).
--
--  2. voice_check_availability gains p_platform_max_outbound: when set, the
--     FLEET count of outbound reservations in flight is checked BEFORE the
--     per-business limits, returning reason 'platform_capacity'. Enforcement
--     is fail-fast pre-dial only: voice_reserve_for_call is deliberately
--     untouched, because a post-dial platform refusal would hang up a leg
--     that already rang someone. Probe races are tolerated; the Telnyx 403
--     classifier (PR 1) is the authoritative backstop and converts the loser
--     into a jittered defer.
--
-- The old 5-arg signature is DROPPED FIRST: `create or replace` with an added
-- parameter would create an OVERLOAD, and PostgREST named-argument dispatch
-- refuses ambiguous overloads at runtime.

alter table voice_reservations
  add column if not exists direction text not null default 'inbound'
    check (direction in ('inbound', 'outbound'));

comment on column voice_reservations.direction is
  'Which way the leg faces. Outbound legs consume the Telnyx account-wide outbound channel pool; the fleet gate in voice_check_availability counts only these. Default inbound; telnyx-voice-originate stamps outbound post-reserve.';

create index if not exists idx_voice_reservations_direction_state
  on voice_reservations (direction, state);

drop function if exists public.voice_check_availability(uuid, integer, timestamptz, integer, integer);

create or replace function voice_check_availability(
  p_business_id uuid,
  p_max_concurrent integer,
  p_stripe_period_start timestamptz,
  p_tier_cap_seconds integer,
  p_min_grant_seconds integer default 60,
  p_platform_max_outbound integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_committed int;
  v_reserved_sum int;
  v_in_flight int;
  v_platform_outbound int;
  v_remaining int;
  v_from_inc int;
  v_bonus_pool int;
  v_bonus_inflight int;
  v_grant int;
begin
  -- Same input guards as the reserve RPC (negative/zero values would corrupt
  -- the headroom math). p_max_grant is irrelevant here: availability only needs
  -- to know the MIN grant is reachable, never how much a single call may hold.
  if p_tier_cap_seconds is null or p_tier_cap_seconds < 0
     or p_max_concurrent is null or p_max_concurrent < 1
     or p_min_grant_seconds is null or p_min_grant_seconds < 1 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_limits');
  end if;

  -- FLEET outbound concurrency, before any per-business math: the Telnyx
  -- account pool is shared, so a full fleet refuses the dial no matter how
  -- much headroom this one tenant has. Null/non-positive = gate off
  -- (rollout safety: an unset env must not block all dialing).
  if p_platform_max_outbound is not null and p_platform_max_outbound > 0 then
    select count(*)::int into v_platform_outbound
    from voice_reservations
    where direction = 'outbound' and state in ('pending_answer', 'active');

    if v_platform_outbound >= p_platform_max_outbound then
      return jsonb_build_object(
        'ok', false,
        'reason', 'platform_capacity',
        'outbound_in_flight', v_platform_outbound
      );
    end if;
  end if;

  -- Concurrency: cross-period, like the reserve RPC (an active call from the
  -- previous period still occupies a media slot).
  select count(*)::int into v_in_flight
  from voice_reservations
  where business_id = p_business_id and state in ('pending_answer', 'active');

  if v_in_flight >= p_max_concurrent then
    return jsonb_build_object('ok', false, 'reason', 'concurrent_limit', 'in_flight', v_in_flight);
  end if;

  select coalesce(committed_included_seconds, 0) into v_committed
  from voice_billing_period_usage
  where business_id = p_business_id and stripe_period_start = p_stripe_period_start;
  if not found then
    v_committed := 0;
  end if;

  -- Period-scoped reserved holds (a still-open call from the prior period
  -- commits against that period row, so it must not subtract from this one).
  select coalesce(sum(reserved_included_seconds), 0) into v_reserved_sum
  from voice_reservations
  where business_id = p_business_id
    and state in ('pending_answer', 'active')
    and stripe_period_start_key = p_stripe_period_start;

  v_remaining := p_tier_cap_seconds - v_committed - v_reserved_sum;
  -- Uncapped included headroom: for a MIN-grant availability test we don't clamp
  -- to p_max_grant (that ceiling only bounds a single reservation's size).
  v_from_inc := greatest(0, v_remaining);

  select coalesce(sum(seconds_remaining), 0) into v_bonus_pool
  from voice_bonus_grants
  where business_id = p_business_id
    and voided_at is null
    and expires_at > now();

  select coalesce(sum(reserved_bonus_seconds), 0) into v_bonus_inflight
  from voice_reservations
  where business_id = p_business_id and state in ('pending_answer', 'active');

  v_bonus_pool := greatest(0, v_bonus_pool - v_bonus_inflight);

  v_grant := v_from_inc + v_bonus_pool;
  if v_grant < p_min_grant_seconds then
    return jsonb_build_object(
      'ok', false,
      'reason', 'quota_exhausted',
      'remaining_seconds', v_remaining,
      'bonus_seconds_available', v_bonus_pool
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'remaining_seconds', v_remaining,
    'bonus_seconds_available', v_bonus_pool,
    'in_flight', v_in_flight
  );
end;
$$;

grant execute on function voice_check_availability(uuid, integer, timestamptz, integer, integer, integer)
  to service_role;

comment on function voice_check_availability(uuid, integer, timestamptz, integer, integer, integer) is
  'Read-only pre-dial budget probe for outbound voice. Replicates voice_reserve_for_call headroom (committed + reserved + bonus, concurrency) WITHOUT minting a reservation, plus an optional FLEET-wide outbound concurrency gate (p_platform_max_outbound; null/non-positive = off) that returns reason platform_capacity before any per-business check. Best-effort: the authoritative per-tenant gate is still voice_reserve_for_call under the real leg id after dial, and the Telnyx 403 classifier backstops probe races.';
