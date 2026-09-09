-- Weighted voice-allowance units for high-cost Terminating LRN minutes.
--
-- Product (locked): do not change voiceTelnyxCentsPerMinute (stays 0.9).
-- High-cost LRN minutes burn more of the tenant's included voice pool,
-- same shape as weighted SMS units, not a fleet-wide rate hike.
-- Weight = (zone termination cents/min) / Zone 1 baseline (0.5c), from
-- LRN / Telnyx term prefix via the zone table. Cap 20 so Zone 6 (36.2x)
-- and Canada N11 (150x) cannot wipe a Starter 25-minute pool from one
-- misdial. Payson +19289512316 with LRN 928363... is Zone 5 at 7c, 14x.
--
-- Missing LRN bills 1x (today's behavior). We never guess from the dialed
-- NPA. Hangup webhooks usually omit LRN; the Edge stamps terminating_lrn
-- when the payload actually has it, and the daily MDR sync backfills via
-- voice_apply_settlement_lrn.
--
-- billable_seconds stays the unweighted Telnyx minute (admin/fleet/refund
-- dollar paths). Extra included seconds are
--   extra = round(billable * zone_weight) - billable
-- added to committed_included_seconds AFTER the existing included/bonus
-- split on the unweighted minute. No second ceil: 33s is still 60
-- unweighted, then 60 * 14 = 840 weighted.
--
-- Reconcile must count extra too, or the 5-minute sweep would undo it
-- (voice_reconcile_period_usage_row previously summed only
-- least(billable, reserved_included)).

alter table voice_settlements
  add column if not exists terminating_lrn text;

alter table voice_settlements
  add column if not exists telnyx_call_leg_id text;

alter table voice_settlements
  add column if not exists zone_weight numeric not null default 1;

alter table voice_settlements
  add column if not exists weighted_billable_seconds integer;

comment on column voice_settlements.terminating_lrn is
  'Telnyx Terminating LRN or term prefix when a hangup payload or later MDR '
  'actually carried one. Null means missing LRN, settlement bills 1x. Never '
  'guessed from the dialed NPA.';

comment on column voice_settlements.telnyx_call_leg_id is
  'Telnyx call_leg_id from hangup, used to match a later sip-trunking MDR '
  'when the MDR has no call_control_id.';

comment on column voice_settlements.zone_weight is
  'Included-pool multiplier for this call, Zone 1 baseline = 1, cap 20. '
  'Payson Zone 5 LRN is 14. Default 1 when LRN is missing.';

comment on column voice_settlements.weighted_billable_seconds is
  'round(billable_seconds * zone_weight). The unweighted Telnyx minute stays '
  'in billable_seconds. Extra (weighted - billable) is committed to the '
  'included pool.';

alter table voice_settlements
  drop constraint if exists voice_settlements_zone_weight_range;

alter table voice_settlements
  add constraint voice_settlements_zone_weight_range
  check (zone_weight >= 1 and zone_weight <= 20);

create index if not exists idx_voice_settlements_call_leg_id
  on voice_settlements (telnyx_call_leg_id)
  where telnyx_call_leg_id is not null;

-- Same signature as 20260505230000 / 20260909214314. Do not add a third
-- argument: zombie sweep and itests call voice_try_finalize_settlement(id)
-- or (id, true). Body starts from the never-answered heal, then adds
-- LRN extra on the already-ceiled Telnyx minute.
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

  -- Weight the already-ceiled Telnyx minute. Default 1 is byte-identical
  -- to today. Extra always hits the membership included pool, not bonus.
  weight := coalesce(s.zone_weight, 1);
  if weight < 1 then
    weight := 1;
  end if;
  if weight > 20 then
    weight := 20;
  end if;
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

-- Recompute included usage from the ledger INCLUDING LRN extra, or the
-- 5-minute sweep would put weighted settlements back to 1x.
create or replace function voice_reconcile_period_usage_row(
  p_business_id uuid,
  p_stripe_period_start timestamptz
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actual int;
  v_expected int;
begin
  select committed_included_seconds into v_actual
  from voice_billing_period_usage
  where business_id = p_business_id and stripe_period_start = p_stripe_period_start
  for update;

  if not found then
    return 0;
  end if;

  select
    coalesce((
      select sum(
        least(s.billable_seconds, r.reserved_included_seconds)
        + greatest(
            coalesce(s.weighted_billable_seconds, s.billable_seconds) - s.billable_seconds,
            0
          )
      )::int
      from voice_settlements s
      join voice_reservations r on r.call_control_id = s.call_control_id
      where r.business_id = p_business_id
        and r.stripe_period_start_key = p_stripe_period_start
        and s.finalized_at is not null
        and s.billable_seconds is not null
    ), 0)
    +
    coalesce((
      select sum(m.billable_seconds)::int
      from voice_forwarded_call_meter m
      where m.business_id = p_business_id
        and m.stripe_period_start = p_stripe_period_start
    ), 0)
  into v_expected;

  if v_expected = v_actual then
    return 0;
  end if;

  update voice_billing_period_usage
  set
    committed_included_seconds = v_expected,
    updated_at = now()
  where business_id = p_business_id and stripe_period_start = p_stripe_period_start;

  return 1;
end;
$$;

comment on function voice_reconcile_period_usage_row is
  'Recomputes one voice_billing_period_usage row''s committed_included_seconds '
  'from the immutable ledgers (finalized settlements x reservations, including '
  'LRN weighted extra, + forwarded call meter) and repairs drift in either '
  'direction. Returns 1 when repaired.';

grant execute on function voice_reconcile_period_usage_row(uuid, timestamptz) to service_role;

-- Stamp LRN/weight from a later MDR and, if already finalized, move the
-- included pool by the weighted delta. Idempotent for the same weight.
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
  weight numeric;
  billable int;
  old_weighted int;
  new_weighted int;
  delta int;
begin
  if p_call_control_id is null or length(trim(p_call_control_id)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'missing_call_control_id');
  end if;

  weight := coalesce(p_zone_weight, 1);
  if weight < 1 then
    weight := 1;
  end if;
  if weight > 20 then
    weight := 20;
  end if;

  select * into s from voice_settlements where call_control_id = p_call_control_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_settlement_row');
  end if;

  update voice_settlements
  set
    terminating_lrn = coalesce(nullif(trim(p_terminating_lrn), ''), terminating_lrn),
    zone_weight = weight
  where call_control_id = p_call_control_id;

  if s.finalized_at is null then
    return jsonb_build_object(
      'ok', true,
      'pending', true,
      'zone_weight', weight
    );
  end if;

  billable := coalesce(s.billable_seconds, 0);
  old_weighted := coalesce(s.weighted_billable_seconds, billable);
  new_weighted := round(billable::numeric * weight)::int;
  delta := new_weighted - old_weighted;

  update voice_settlements
  set weighted_billable_seconds = new_weighted
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
