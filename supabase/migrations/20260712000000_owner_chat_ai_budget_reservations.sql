-- AI-budget reservations for live voice (Gemini Live) — concurrency hard stop.
--
-- Context: chat/SMS meter Gemini spend into owner_chat_model_spend AFTER each
-- turn, which is fine because those turns are cheap and serial. A live voice
-- call is different: it can run for minutes and its Gemini Live cost is only
-- known (and recorded) at teardown. The pre-call gate and the mid-call session
-- cap both read the PERSISTED spend, so two or three concurrent AI calls could
-- each read the same "remaining budget" and each run a full budget-sized session
-- before any of their costs land — overshooting the shared $5/$10 AI hard stop.
--
-- Fix (mirrors the voice-minute reservation model in voice_reserve_for_call):
-- reserve an estimate of a call's max Gemini Live cost at answer time, so
-- concurrent calls see the reservation and get a shorter/refused session; then
-- SETTLE the reservation to the EXACT metered spend at teardown (release the
-- reservation, record the real cost). Reservations expire so a crashed/abandoned
-- call auto-frees its hold; the "remaining" read ignores expired rows.
--
-- No floats: micro-USD (1e-6 USD) integers, same as owner_chat_model_spend.
-- Serialized per business with a transaction advisory lock so concurrent
-- reservations can't both pass the cap check on stale reads.

-- ---------------------------------------------------------------------------
-- Per-call reservation ledger.
-- ---------------------------------------------------------------------------
create table if not exists owner_chat_spend_reservations (
  -- Telnyx call_control_id — one live reservation per call, idempotent re-reserve.
  call_control_id text primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  -- Billing period the reservation counts against (subscriptions.stripe_current_period_start).
  period_start timestamptz not null,
  -- Micro-USD currently held for this call. Zeroed on settle/release.
  reserved_micros bigint not null default 0 check (reserved_micros >= 0),
  state text not null default 'active' check (state in ('active', 'settled', 'released')),
  -- Active reservations past this time are ignored by the "remaining" read, so a
  -- crashed call that never settles can't pin budget forever.
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_owner_chat_resv_biz_period_active
  on owner_chat_spend_reservations (business_id, period_start, state, expires_at);

alter table owner_chat_spend_reservations enable row level security;

drop policy if exists "Service role manages owner_chat_spend_reservations"
  on owner_chat_spend_reservations;
create policy "Service role manages owner_chat_spend_reservations"
  on owner_chat_spend_reservations for all
  using (auth.role() = 'service_role');

comment on table owner_chat_spend_reservations is
  'Per-call AI-budget holds for live voice (Gemini Live). Reserved at answer time and settled to exact spend at teardown so concurrent calls cannot collectively overshoot the shared owner_chat_model_spend cap. Micro-USD; expires so abandoned calls auto-free.';

-- ---------------------------------------------------------------------------
-- Reserve budget for a call. Serialized per business (advisory xact lock) so
-- concurrent reservations see each other's holds. Idempotent per call_control_id.
--
-- Returns ok=false only when the pool is already fully committed (spend + other
-- active reservations >= cap). Otherwise it inserts a hold clamped to the
-- remaining headroom and returns the headroom (BEFORE this call's own hold) as
-- remaining_micros, so the caller can still refuse when that headroom is below a
-- minimum viable session.
-- ---------------------------------------------------------------------------
create or replace function owner_chat_ai_reserve(
  p_business_id uuid,
  p_period_start timestamptz,
  p_call_control_id text,
  p_reserve_micros bigint,
  p_cap_micros bigint,
  p_ttl_seconds integer default 1800
)
returns table (ok boolean, remaining_micros bigint, duplicate boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_spend bigint;
  v_other_reserved bigint;
  v_committed bigint;
  v_existing owner_chat_spend_reservations%rowtype;
  v_hold bigint;
begin
  -- Serialize reservations for this business so two concurrent calls can't both
  -- read a stale "committed" total and both slip past the cap.
  perform pg_advisory_xact_lock(hashtext(p_business_id::text));

  select * into v_existing
    from owner_chat_spend_reservations
    where call_control_id = p_call_control_id;

  select coalesce(spend_micros, 0) into v_spend
    from owner_chat_model_spend
    where business_id = p_business_id and period_start = p_period_start;
  v_spend := coalesce(v_spend, 0);

  select coalesce(sum(reserved_micros), 0) into v_other_reserved
    from owner_chat_spend_reservations
    where business_id = p_business_id
      and period_start = p_period_start
      and state = 'active'
      and expires_at > now()
      and call_control_id <> p_call_control_id;

  v_committed := v_spend + coalesce(v_other_reserved, 0);
  remaining_micros := greatest(p_cap_micros - v_committed, 0);

  -- Idempotent re-reserve (Telnyx webhook retry): keep the existing active hold.
  if v_existing.call_control_id is not null
     and v_existing.state = 'active'
     and v_existing.expires_at > now() then
    ok := v_committed < p_cap_micros;
    duplicate := true;
    return next;
    return;
  end if;

  if v_committed >= p_cap_micros then
    ok := false;
    duplicate := false;
    return next;
    return;
  end if;

  v_hold := least(greatest(p_reserve_micros, 0), p_cap_micros - v_committed);

  insert into owner_chat_spend_reservations (
    call_control_id, business_id, period_start, reserved_micros, state, expires_at, updated_at
  )
  values (
    p_call_control_id, p_business_id, p_period_start, v_hold, 'active',
    now() + make_interval(secs => greatest(p_ttl_seconds, 60)), now()
  )
  on conflict (call_control_id) do update
    set business_id = excluded.business_id,
        period_start = excluded.period_start,
        reserved_micros = excluded.reserved_micros,
        state = 'active',
        expires_at = excluded.expires_at,
        updated_at = now();

  ok := true;
  duplicate := false;
  return next;
end;
$$;

comment on function owner_chat_ai_reserve is
  'Atomically hold an estimate of a live-voice call''s Gemini Live cost against the shared AI budget (serialized per business). Idempotent per call_control_id. Returns ok=false when the pool is already fully committed, else the headroom before this hold.';

-- ---------------------------------------------------------------------------
-- Remaining AI budget (micro-USD) = cap - persisted spend - active holds.
-- Excludes one call (the caller's own reservation) so a bridge can size its own
-- session against what OTHER concurrent calls have committed.
-- ---------------------------------------------------------------------------
create or replace function owner_chat_ai_remaining(
  p_business_id uuid,
  p_period_start timestamptz,
  p_cap_micros bigint,
  p_exclude_call_control_id text default null
)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
    p_cap_micros
      - coalesce((
          select spend_micros from owner_chat_model_spend
          where business_id = p_business_id and period_start = p_period_start
        ), 0)
      - coalesce((
          select sum(reserved_micros) from owner_chat_spend_reservations
          where business_id = p_business_id
            and period_start = p_period_start
            and state = 'active'
            and expires_at > now()
            and (p_exclude_call_control_id is null
                 or call_control_id <> p_exclude_call_control_id)
        ), 0),
    0
  )::bigint;
$$;

comment on function owner_chat_ai_remaining is
  'Remaining shared AI budget (micro-USD) after persisted spend and active reservations, optionally excluding one call''s own reservation.';

-- ---------------------------------------------------------------------------
-- Settle a call: release its reservation and record the EXACT metered spend.
-- Atomic + fuse (same crossing semantics as owner_chat_record_spend) so the
-- one-time owner cap alert still fires. A non-positive actual just releases the
-- hold without inflating the meter.
-- ---------------------------------------------------------------------------
create or replace function owner_chat_ai_settle(
  p_business_id uuid,
  p_period_start timestamptz,
  p_call_control_id text,
  p_actual_micros bigint,
  p_cap_micros bigint
)
returns table (spend_micros bigint, fuse_newly_tripped boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_was_tripped boolean;
  v_new_total bigint;
  v_now_tripped boolean;
begin
  perform pg_advisory_xact_lock(hashtext(p_business_id::text));

  update owner_chat_spend_reservations
    set state = 'settled', reserved_micros = 0, updated_at = now()
    where call_control_id = p_call_control_id;

  if coalesce(p_actual_micros, 0) <= 0 then
    select coalesce(spend_micros, 0) into v_new_total
      from owner_chat_model_spend
      where business_id = p_business_id and period_start = p_period_start;
    spend_micros := coalesce(v_new_total, 0);
    fuse_newly_tripped := false;
    return next;
    return;
  end if;

  insert into owner_chat_model_spend (business_id, period_start, spend_micros, turn_count, updated_at)
  values (p_business_id, p_period_start, p_actual_micros, 1, now())
  on conflict (business_id, period_start) do update
    set spend_micros = owner_chat_model_spend.spend_micros + p_actual_micros,
        turn_count = owner_chat_model_spend.turn_count + 1,
        updated_at = now()
  returning
    owner_chat_model_spend.spend_micros,
    (owner_chat_model_spend.fuse_tripped_at is not null)
  into v_new_total, v_was_tripped;

  v_now_tripped := false;
  if not v_was_tripped and v_new_total >= p_cap_micros then
    update owner_chat_model_spend
      set fuse_tripped_at = now()
      where business_id = p_business_id and period_start = p_period_start;
    v_now_tripped := true;
  end if;

  spend_micros := v_new_total;
  fuse_newly_tripped := v_now_tripped;
  return next;
end;
$$;

comment on function owner_chat_ai_settle is
  'Release a live-voice AI-budget reservation and add the exact metered Gemini Live spend to the shared meter, tripping the fuse on first cap crossing. Returns new total + whether this settle tripped the fuse.';

-- ---------------------------------------------------------------------------
-- Release a reservation without charging (call refused/abandoned/failed).
-- ---------------------------------------------------------------------------
create or replace function owner_chat_ai_release(p_call_control_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update owner_chat_spend_reservations
    set state = 'released', reserved_micros = 0, updated_at = now()
    where call_control_id = p_call_control_id and state = 'active';
$$;

comment on function owner_chat_ai_release is
  'Release a live-voice AI-budget reservation without recording spend (call refused/abandoned/failed).';

revoke all on function owner_chat_ai_reserve(uuid, timestamptz, text, bigint, bigint, integer) from public;
grant execute on function owner_chat_ai_reserve(uuid, timestamptz, text, bigint, bigint, integer) to service_role;
revoke all on function owner_chat_ai_remaining(uuid, timestamptz, bigint, text) from public;
grant execute on function owner_chat_ai_remaining(uuid, timestamptz, bigint, text) to service_role;
revoke all on function owner_chat_ai_settle(uuid, timestamptz, text, bigint, bigint) from public;
grant execute on function owner_chat_ai_settle(uuid, timestamptz, text, bigint, bigint) to service_role;
revoke all on function owner_chat_ai_release(text) from public;
grant execute on function owner_chat_ai_release(text) to service_role;
