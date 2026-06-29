-- Outbound voice: pre-dial budget gate + scheduled auto-dial ledger.
--
-- Two additions that let an outbound `outbound_call` AiFlow be both metered
-- BEFORE it spends and placed automatically on a schedule:
--
--  1. voice_check_availability(...) — a READ-ONLY sibling of
--     voice_reserve_for_call. The reserve RPC keys a reservation by a Telnyx
--     call_control_id, which only exists once dialing has started; so to honor
--     "metered before spend" without minting a reservation, the originate Edge
--     fn calls this first to learn whether ANY reservation of at least
--     p_min_grant_seconds could be granted right now. If not, it never dials —
--     the callee's phone never rings for an over-budget tenant. The post-dial
--     reserve under the real leg id remains the AUTHORITATIVE gate (this check
--     is a best-effort pre-flight; a race that slips past it is still caught by
--     the reserve before any media/answer is billed).
--
--  2. voice_outbound_dial_log — an exactly-once ledger for SCHEDULED outbound
--     calls. Outbound voice flows never enqueue an ai_flow_run (the batch
--     engine has no outbound_call processor), so the worker's schedule sweep
--     can't use the run table's dedupe. This table's unique (flow_id,
--     dedupe_key) gives the same exactly-once-per-occurrence guarantee for the
--     call path: the sweep inserts the row first (a 23505 means "already dialed
--     this occurrence") and only then places the call.

-- ---------------------------------------------------------------------------
-- 1. Read-only budget availability.
-- ---------------------------------------------------------------------------
-- Mirrors the headroom math in voice_reserve_for_call WITHOUT inserting a
-- reservation or taking the per-business advisory lock: it answers "could a
-- call get at least p_min_grant_seconds right now?" by replicating the
-- committed + reserved + bonus accounting. `stable` (no writes) so the planner
-- and callers can treat it as a pure read.
create or replace function voice_check_availability(
  p_business_id uuid,
  p_max_concurrent integer,
  p_stripe_period_start timestamptz,
  p_tier_cap_seconds integer,
  p_min_grant_seconds integer default 60
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

grant execute on function voice_check_availability(uuid, integer, timestamptz, integer, integer)
  to service_role;

comment on function voice_check_availability(uuid, integer, timestamptz, integer, integer) is
  'Read-only pre-dial budget probe for outbound voice. Replicates voice_reserve_for_call headroom (committed + reserved + bonus, concurrency) WITHOUT minting a reservation. Returns { ok, reason, remaining_seconds, bonus_seconds_available, in_flight }. Best-effort: the authoritative gate is still voice_reserve_for_call under the real leg id after dial.';

-- ---------------------------------------------------------------------------
-- 2. Scheduled outbound-dial exactly-once ledger.
-- ---------------------------------------------------------------------------
create table if not exists public.voice_outbound_dial_log (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.ai_flows(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Occurrence key from schedule.ts (e.g. "d:2026-06-29T09:00" or "i60:482736").
  dedupe_key text not null,
  -- The placed leg, once originate returns one (null for blocked/failed).
  call_control_id text,
  status text not null default 'placed' check (status in ('placed', 'blocked', 'failed')),
  -- Budget/dial refusal reason when status <> 'placed'.
  reason text,
  created_at timestamptz not null default now(),
  unique (flow_id, dedupe_key)
);

create index if not exists idx_voice_outbound_dial_log_business
  on public.voice_outbound_dial_log (business_id, created_at desc);

alter table public.voice_outbound_dial_log enable row level security;

drop policy if exists "Service role manages voice_outbound_dial_log" on public.voice_outbound_dial_log;
create policy "Service role manages voice_outbound_dial_log"
  on public.voice_outbound_dial_log for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "Owner reads own voice_outbound_dial_log" on public.voice_outbound_dial_log;
create policy "Owner reads own voice_outbound_dial_log"
  on public.voice_outbound_dial_log for select
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

comment on table public.voice_outbound_dial_log is
  'Exactly-once ledger for SCHEDULED outbound voice AiFlow calls. Outbound voice flows never enqueue an ai_flow_run, so the worker schedule sweep dedupes here instead: unique (flow_id, dedupe_key) turns repeat ticks inside a due window into a benign 23505. One row per placed/blocked/failed occurrence.';
