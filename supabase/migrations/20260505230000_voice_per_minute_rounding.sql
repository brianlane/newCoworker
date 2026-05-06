-- Align voice settlement billing with carrier per-minute rounding.
--
-- Background: Telnyx (and every other PSTN carrier) bills inbound calls in
-- 60-second increments, ROUNDED UP. A 9-second call bills as 60s; a
-- 92-second call bills as 120s. Sample CDR from 2026-05-05:
--
--   Call duration | Billable time
--   33s           | 60s
--   9s            | 60s
--   92s           | 120s
--
-- Until this migration `voice_try_finalize_settlement` rounded `elapsed`
-- to the next whole SECOND (`ceil(elapsed)::int`). That under-bills the
-- customer relative to the carrier cost we actually pay — a 9s call only
-- debited 9s from the included pool while we owed Telnyx for 60s. Across
-- a high-volume short-call workload this is a meaningful margin leak.
--
-- The fix:
--   wall_cap   := ceil(elapsed / 60.0)::int * 60
--   carrier_cap := ceil(telnyx_reported_duration_seconds / 60.0)::int * 60
--
-- Forward-only: this migration only changes how NEW finalizes round.
-- Already-finalized rows in `voice_settlements` keep their per-second
-- billable_seconds. Their `committed_included_seconds` total in
-- `voice_billing_period_usage` is also untouched — we don't retroactively
-- claw back included quota or push a customer over their plan because the
-- model changed.
--
-- The zero-turn guard from `20260505190000_voice_no_bill_when_zero_turns`
-- still wins: a call with no transcript turns settles at 0 regardless of
-- elapsed wall-clock, because no service was rendered.
--
-- The `reserved_total_seconds` cap still wins: if rounding pushes
-- `wall_cap` above what the caller reserved at call-start, we clamp back
-- down so a 245s reservation never settles at 300s.

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
      'committed_included_seconds', 0,
      'committed_bonus_seconds', 0,
      'no_turns_zero_billed', true
    );
  end if;

  commit_inc := least(billable, r.reserved_included_seconds);
  commit_bon := least(billable - commit_inc, r.reserved_bonus_seconds);

  -- Per-grant snapshot is the preferred debit path (§4.3). If a snapshotted grant was voided or
  -- refunded between reserve and finalize, fall back to FIFO over any remaining live grants for
  -- the shortfall. If bonus STILL can't be fully debited, reduce billable so we never over-bill —
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

  update voice_billing_period_usage
  set
    committed_included_seconds = committed_included_seconds + commit_inc,
    updated_at = now()
  where business_id = r.business_id and stripe_period_start = r.stripe_period_start_key;

  update voice_settlements
  set
    billable_seconds = billable,
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
    'committed_included_seconds', commit_inc,
    'committed_bonus_seconds', commit_bon
  );
end;
$$;

grant execute on function voice_try_finalize_settlement(text, boolean) to service_role;
