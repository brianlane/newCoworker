-- Duration proxy for LRN voice-allowance weight.
--
-- Product: VOICE_ALLOWANCE_WEIGHT_CAP (20) is tenant protection for a
-- SHORT Telnyx minute only (billable_seconds <= 60: AMD, voicemail,
-- misdials). Once billable_seconds > 60, the whole settlement uses the
-- uncapped zone multiplier (zone cents / 0.5). Not a hybrid first-minute
-- cap. voiceTelnyxCentsPerMinute stays 0.9.
--
-- Hangup / MDR still stamp the RAW zone multiplier. Finalize and
-- voice_apply_settlement_lrn apply this duration rule from THAT
-- settlement's billable_seconds. Missing LRN stays 1x.
--
-- Lockstep with supabase/functions/_shared/voice_zone_rates.ts:
--   VOICE_ALLOWANCE_SHORT_LEG_SECONDS = 60
--   VOICE_ALLOWANCE_WEIGHT_CAP = 20
--   VOICE_ALLOWANCE_WEIGHT_STORE_MAX = 200

alter table voice_settlements
  drop constraint if exists voice_settlements_zone_weight_range;

alter table voice_settlements
  add constraint voice_settlements_zone_weight_range
  check (zone_weight >= 1 and zone_weight <= 200);

comment on column voice_settlements.zone_weight is
  'Included-pool multiplier for this call, Zone 1 baseline = 1. '
  'Pending rows may hold the RAW zone rate (Zone 6 = 36.2, Canada N11 = 150). '
  'After finalize, this is the duration-gated effective weight: cap 20 when '
  'billable_seconds <= 60, otherwise the full raw multiplier. Missing LRN is 1.';

-- Shared duration rule. Called only by finalize / apply; granted so
-- worker-integration can assert the formula against the live stack.
create or replace function voice_effective_allowance_weight(
  p_raw numeric,
  p_billable_seconds integer
)
returns numeric
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select case
    when coalesce(p_billable_seconds, 0) > 60
      then least(greatest(coalesce(p_raw, 1), 1), 200)
    else least(greatest(coalesce(p_raw, 1), 1), 20)
  end;
$$;

comment on function voice_effective_allowance_weight(numeric, integer) is
  'Duration-gated LRN allowance weight. Cap 20 when billable_seconds is null '
  'or <= 60; otherwise the raw zone multiplier, store-ceiling 200.';

grant execute on function voice_effective_allowance_weight(numeric, integer) to service_role;

-- Same two-arg signature as 20260909221513. Weight section now duration-gates
-- instead of a hard 20 ceiling. Never-answered 0-billable heal is unchanged.
create or replace function voice_try_finalize_settlement(
  p_call_control_id text,
  p_allow_one_sided boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r voice_reservations%rowtype;
  s voice_settlements%rowtype;
  sess_media_start timestamptz;
  v_start timestamptz;
  v_end timestamptz;
  elapsed numeric;
  billable int;
  wall_cap int;
  carrier_cap int;
  carrier_raw int;
  commit_inc int;
  commit_bon int;
  t_tel timestamptz;
  t_br timestamptz;
  v_bon_took int;
  v_turn_count int;
  weight numeric;
  weighted_billable int;
  extra int;
begin
  select * into s from voice_settlements where call_control_id = p_call_control_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_settlement_row');
  end if;

  if s.finalized_at is not null then
    return jsonb_build_object('ok', true, 'already_finalized', true);
  end if;

  select * into r from voice_reservations where call_control_id = p_call_control_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_reservation');
  end if;

  -- Hangup-before-answer already released the hold. Close at 0 rather than
  -- leaving a row the health cron will page on forever. A released
  -- reservation that DID connect is still refused below: those minutes were
  -- returned and we must not commit them a second time.
  if r.state = 'released'
     and r.ws_connected_at is null
     and r.answer_issued_at is null then
    update voice_settlements
    set
      billable_seconds = 0,
      weighted_billable_seconds = 0,
      finalized_at = now(),
      no_turns_zero_billed = true,
      settlement_idempotency_key = coalesce(settlement_idempotency_key, gen_random_uuid()::text),
      reservation_id = coalesce(voice_settlements.reservation_id, r.id)
    where call_control_id = p_call_control_id;

    return jsonb_build_object(
      'ok', true,
      'billable_seconds', 0,
      'weighted_billable_seconds', 0,
      'committed_included_seconds', 0,
      'committed_bonus_seconds', 0,
      'no_turns_zero_billed', true,
      'never_answered', true
    );
  end if;

  if r.state = 'released' then
    return jsonb_build_object('ok', false, 'reason', 'reservation_released');
  end if;

  t_tel := s.telnyx_ended_at;
  t_br := s.bridge_media_ended_at;

  if not p_allow_one_sided and (t_tel is null or t_br is null) then
    return jsonb_build_object('ok', false, 'reason', 'awaiting_signals');
  end if;

  if t_tel is not null and t_br is not null then
    v_end := least(t_tel, t_br);
  elsif p_allow_one_sided then
    v_end := coalesce(least(t_tel, t_br), t_tel, t_br, now());
  else
    return jsonb_build_object('ok', false, 'reason', 'awaiting_signals');
  end if;

  select media_started_at into sess_media_start
  from voice_active_sessions where call_control_id = p_call_control_id;

  v_start := coalesce(r.ws_connected_at, sess_media_start, r.answer_issued_at, r.created_at);

  elapsed := extract(epoch from (v_end - v_start));
  if elapsed < 0 then
    elapsed := 0;
  end if;

  -- Per-MINUTE rounding (telecom carrier convention): a 33s call bills as
  -- 60, a 92s call bills as 120. Matches the Telnyx CDR `Billable time`
  -- column exactly so reconciliation is byte-clean.
  if elapsed = 0 then
    wall_cap := 0;
  else
    wall_cap := (ceil(elapsed / 60.0))::int * 60;
  end if;
  if wall_cap > r.reserved_total_seconds then
    wall_cap := r.reserved_total_seconds;
  end if;

  carrier_raw := s.telnyx_reported_duration_seconds;
  if carrier_raw is not null and carrier_raw >= 0 then
    -- Telnyx reports raw seconds in the webhook (e.g. 33), but bills its
    -- next-minute rounded value (60). Round our cap the same way so we
    -- don't punish the carrier_cap branch for telling us the truth.
    if carrier_raw = 0 then
      carrier_cap := 0;
    else
      carrier_cap := (ceil(carrier_raw / 60.0))::int * 60;
    end if;
    billable := least(wall_cap, carrier_cap);
  else
    billable := wall_cap;
  end if;

  if billable > r.reserved_total_seconds then
    billable := r.reserved_total_seconds;
  end if;

  -- Zero-turn guard (carried over from the prior migration): a call that
  -- connected the bridge but produced no transcript turns is always 0
  -- billable, regardless of wall-clock or carrier rounding. We still ate
  -- the carrier minute, but charging the customer when no AI service was
  -- rendered is indefensible.
  select count(*) into v_turn_count
  from voice_call_transcript_turns t
  join voice_call_transcripts vct on vct.id = t.transcript_id
  where vct.call_control_id = p_call_control_id;

  if v_turn_count = 0 then
    update voice_settlements
    set
      billable_seconds = 0,
      weighted_billable_seconds = 0,
      finalized_at = now(),
      no_turns_zero_billed = true,
      settlement_idempotency_key = coalesce(settlement_idempotency_key, gen_random_uuid()::text),
      reservation_id = coalesce(voice_settlements.reservation_id, r.id)
    where call_control_id = p_call_control_id;

    update voice_reservations
    set state = 'settled', updated_at = now()
    where call_control_id = p_call_control_id and state in ('active', 'pending_answer');

    return jsonb_build_object(
      'ok', true,
      'billable_seconds', 0,
      'weighted_billable_seconds', 0,
      'committed_included_seconds', 0,
      'committed_bonus_seconds', 0,
      'no_turns_zero_billed', true
    );
  end if;

  commit_inc := least(billable, r.reserved_included_seconds);
  commit_bon := least(billable - commit_inc, r.reserved_bonus_seconds);

  -- Per-grant snapshot is the preferred debit path (§4.3). If a snapshotted grant was voided or
  -- refunded between reserve and finalize, fall back to FIFO over any remaining live grants for
  -- the shortfall. If bonus STILL can't be fully debited, reduce billable so we never over-bill:
  -- better to under-bill a dispute-safe amount than to leave the settlement stuck forever.
  if commit_bon > 0 then
    if r.bonus_grant_allocations is not null and jsonb_typeof(r.bonus_grant_allocations) = 'array'
       and jsonb_array_length(r.bonus_grant_allocations) > 0 then
      v_bon_took := consume_voice_bonus_from_allocations(
        r.business_id,
        r.bonus_grant_allocations,
        commit_bon
      );
      if v_bon_took < commit_bon then
        v_bon_took := v_bon_took + consume_voice_bonus_seconds(
          r.business_id,
          commit_bon - v_bon_took
        );
      end if;
    else
      v_bon_took := consume_voice_bonus_seconds(r.business_id, commit_bon);
    end if;

    if v_bon_took <> commit_bon then
      billable := billable - (commit_bon - v_bon_took);
      commit_bon := v_bon_took;
    end if;
  end if;

  -- Duration-gated weight on the already-ceiled Telnyx minute. Pending
  -- rows may hold a RAW Zone 6 / N11 multiplier; cap 20 only when this
  -- settlement is one billed minute or less. Extra always hits the
  -- membership included pool, not bonus.
  weight := voice_effective_allowance_weight(s.zone_weight, billable);
  weighted_billable := round(billable::numeric * weight)::int;
  extra := greatest(weighted_billable - billable, 0);

  update voice_billing_period_usage
  set
    committed_included_seconds = committed_included_seconds + commit_inc + extra,
    updated_at = now()
  where business_id = r.business_id and stripe_period_start = r.stripe_period_start_key;

  update voice_settlements
  set
    billable_seconds = billable,
    weighted_billable_seconds = weighted_billable,
    zone_weight = weight,
    finalized_at = now(),
    settlement_idempotency_key = coalesce(settlement_idempotency_key, gen_random_uuid()::text),
    reservation_id = coalesce(voice_settlements.reservation_id, r.id)
  where call_control_id = p_call_control_id;

  update voice_reservations
  set state = 'settled', updated_at = now()
  where call_control_id = p_call_control_id and state in ('active', 'pending_answer');

  return jsonb_build_object(
    'ok', true,
    'billable_seconds', billable,
    'weighted_billable_seconds', weighted_billable,
    'committed_included_seconds', commit_inc + extra,
    'committed_bonus_seconds', commit_bon,
    'zone_weight', weight
  );
end;
$$;

grant execute on function voice_try_finalize_settlement(text, boolean) to service_role;

-- Stamp RAW LRN/weight from a later MDR. Pending keeps the raw so finalize
-- can duration-gate. Already-finalized rows use this settlement's
-- billable_seconds for the cap decision, then move the included pool by
-- the weighted delta. Idempotent for the same effective weight.
create or replace function voice_apply_settlement_lrn(
  p_call_control_id text,
  p_terminating_lrn text,
  p_zone_weight numeric
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  s voice_settlements%rowtype;
  r voice_reservations%rowtype;
  weight_raw numeric;
  weight numeric;
  billable int;
  old_weighted int;
  new_weighted int;
  delta int;
begin
  if p_call_control_id is null or length(trim(p_call_control_id)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'missing_call_control_id');
  end if;

  -- Store ceiling only. Duration cap happens below once billable is known.
  weight_raw := least(greatest(coalesce(p_zone_weight, 1), 1), 200);

  select * into s from voice_settlements where call_control_id = p_call_control_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_settlement_row');
  end if;

  if s.finalized_at is null then
    update voice_settlements
    set
      terminating_lrn = coalesce(nullif(trim(p_terminating_lrn), ''), terminating_lrn),
      zone_weight = weight_raw
    where call_control_id = p_call_control_id;

    return jsonb_build_object(
      'ok', true,
      'pending', true,
      'zone_weight', weight_raw
    );
  end if;

  billable := coalesce(s.billable_seconds, 0);
  weight := voice_effective_allowance_weight(weight_raw, billable);
  old_weighted := coalesce(s.weighted_billable_seconds, billable);
  new_weighted := round(billable::numeric * weight)::int;
  delta := new_weighted - old_weighted;

  update voice_settlements
  set
    terminating_lrn = coalesce(nullif(trim(p_terminating_lrn), ''), terminating_lrn),
    zone_weight = weight,
    weighted_billable_seconds = new_weighted
  where call_control_id = p_call_control_id;

  if delta = 0 then
    return jsonb_build_object(
      'ok', true,
      'unchanged', true,
      'zone_weight', weight,
      'weighted_billable_seconds', new_weighted
    );
  end if;

  select * into r from voice_reservations where call_control_id = p_call_control_id;
  if found then
    update voice_billing_period_usage
    set
      committed_included_seconds = committed_included_seconds + delta,
      updated_at = now()
    where business_id = r.business_id and stripe_period_start = r.stripe_period_start_key;
  end if;

  return jsonb_build_object(
    'ok', true,
    'delta_included_seconds', delta,
    'zone_weight', weight,
    'weighted_billable_seconds', new_weighted
  );
end;
$$;

grant execute on function voice_apply_settlement_lrn(text, text, numeric) to service_role;
