-- Don't bill voice minutes for calls that connected the bridge but never
-- produced an LLM turn (i.e. silent dead-air calls).
--
-- Background: in May 2026 the voice path went through a series of audio
-- codec / RTP-framing / Gemini-Live-API regressions. During the live
-- debug-and-redeploy cycles the bridge would WS-connect (so the
-- reservation entered `active`/`settled`), Telnyx would charge wall-clock
-- duration via voice_settlements, and the settlement RPC would commit
-- those seconds to `committed_included_seconds`. Customers ended up
-- charged for ~30+ test calls during which the bridge produced nothing
-- audible. We've also seen real-world dead-air scenarios (e.g. caller
-- abandons before greeting, model failure, tunnel hiccup) where billing
-- the customer is indefensible because no service was rendered.
--
-- The new guard inspects voice_call_transcript_turns for the call: if
-- ZERO turns are present at finalize time, we settle the reservation as
-- non-billable (commit_inc = 0, commit_bon = 0, billable_seconds = 0).
-- Reservation still moves to `settled` so the slot is freed and Telnyx's
-- webhooks don't keep retrying. We also stamp a marker into
-- voice_settlements.no_turns_zero_billed for ops visibility / refund
-- traceability without needing a new column on the reservation.
--
-- This intentionally trades off the (rare) case where a call is genuinely
-- billable but the transcript writer crashed before flushing — that's
-- already covered by per-business support refunds, and the bigger
-- product risk is unjustly billing customers for tests/failures.

alter table voice_settlements
  add column if not exists no_turns_zero_billed boolean not null default false;

comment on column voice_settlements.no_turns_zero_billed is
  'voice_try_finalize_settlement set this to true when the call had zero '
  'transcript turns at finalize time, so we stamped billable=0 and committed=0.';

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

  -- Round up (telecom per-second billing convention): a 4.2s media leg bills as 5, not 4.
  -- Floor here would under-bill every partial second and would also let a call that
  -- connected for 0.9s settle at 0 billable seconds even though it consumed a trunk and
  -- an LLM turn. ceil aligns with Telnyx/Twilio call-duration reporting and the UI copy.
  wall_cap := ceil(elapsed)::int;
  if wall_cap > r.reserved_total_seconds then
    wall_cap := r.reserved_total_seconds;
  end if;

  carrier_cap := s.telnyx_reported_duration_seconds;
  if carrier_cap is not null and carrier_cap >= 0 then
    billable := least(wall_cap, carrier_cap);
  else
    billable := wall_cap;
  end if;

  if billable > r.reserved_total_seconds then
    billable := r.reserved_total_seconds;
  end if;

  -- Zero-turn guard: if the bridge connected but never wrote a transcript
  -- turn, the AI delivered no value to the caller — don't bill. Joins the
  -- transcript by call_control_id (transcripts are scoped per-call) and
  -- counts turns; even a single caller turn is enough to consider the
  -- call billable, because that means uplink audio reached the model.
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
