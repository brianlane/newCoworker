-- §5–§6: Webhook at-least-once — allow Telnyx retries to re-drive work until marked complete.
-- §4: Included-pool headroom uses reserved_included_seconds only (bonus does not shrink included).
-- §4.3: When bonus_grant_allocations is set, bonus debit follows the snapshot only (no FIFO fallback).
--        Partial debit vs commit_bon returns bonus_allocation_shortfall (no finalize).
-- SMS: idempotent job enqueue on telnyx_event_id for duplicate deliveries.

alter table telnyx_webhook_events
  add column if not exists completed_at timestamptz;

comment on column telnyx_webhook_events.completed_at is
  'When set, this webhook event is fully processed; duplicate deliveries return status done. Null means a retry may re-run the handler.';

update telnyx_webhook_events
set completed_at = coalesce(completed_at, received_at)
where completed_at is null;

create or replace function telnyx_webhook_try_begin(p_event_id text, p_event_type text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done timestamptz;
begin
  begin
    insert into telnyx_webhook_events (event_id, event_type)
    values (p_event_id, p_event_type);
    return jsonb_build_object('status', 'new');
  exception
    when unique_violation then
      null;
  end;

  select completed_at into v_done from telnyx_webhook_events where event_id = p_event_id;
  if v_done is null then
    return jsonb_build_object('status', 'retry');
  end if;
  return jsonb_build_object('status', 'done');
end;
$$;

grant execute on function telnyx_webhook_try_begin(text, text) to service_role;

create or replace function telnyx_webhook_mark_complete(p_event_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update telnyx_webhook_events
  set completed_at = coalesce(completed_at, now())
  where event_id = p_event_id and completed_at is null;
$$;

grant execute on function telnyx_webhook_mark_complete(text) to service_role;

create unique index if not exists idx_sms_inbound_jobs_telnyx_event_id_unique
  on sms_inbound_jobs (telnyx_event_id)
  where telnyx_event_id is not null;

-- Included headroom: sum only included seconds held by in-flight reservations (bonus is tracked separately).
create or replace function voice_reserve_for_call(
  p_business_id uuid,
  p_call_control_id text,
  p_tier text,
  p_max_concurrent integer,
  p_stripe_period_start timestamptz,
  p_tier_cap_seconds integer,
  p_min_grant_seconds integer default 60,
  p_max_grant_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_committed int;
  v_reserved_sum int;
  v_in_flight int;
  v_remaining int;
  v_from_inc int;
  v_from_bon int;
  v_grant int;
  v_bonus_pool int;
  v_bonus_inflight int;
  v_need int;
  v_row voice_reservations%rowtype;
  v_alloc jsonb := '[]'::jsonb;
  v_left int;
  gr record;
  v_inflight_gr int;
  v_eff int;
  chunk int;
begin
  insert into business_voice_quota_lock (business_id) values (p_business_id)
  on conflict (business_id) do nothing;

  perform 1 from business_voice_quota_lock where business_id = p_business_id for update;

  select * into v_row from voice_reservations where call_control_id = p_call_control_id;
  if found then
    if v_row.state in ('pending_answer', 'active') then
      return jsonb_build_object(
        'ok', true,
        'duplicate', true,
        'grant_seconds', v_row.reserved_total_seconds,
        'reservation_id', v_row.id
      );
    end if;
  end if;

  select coalesce(committed_included_seconds, 0) into v_committed
  from voice_billing_period_usage
  where business_id = p_business_id and stripe_period_start = p_stripe_period_start;

  if not found then
    v_committed := 0;
    insert into voice_billing_period_usage (business_id, stripe_period_start, tier_cap_seconds, committed_included_seconds)
    values (p_business_id, p_stripe_period_start, p_tier_cap_seconds, 0)
    on conflict (business_id, stripe_period_start) do nothing;
  end if;

  select coalesce(sum(reserved_included_seconds), 0) into v_reserved_sum
  from voice_reservations
  where business_id = p_business_id and state in ('pending_answer', 'active');

  select count(*)::int into v_in_flight
  from voice_reservations
  where business_id = p_business_id and state in ('pending_answer', 'active');

  if v_in_flight >= p_max_concurrent then
    return jsonb_build_object('ok', false, 'reason', 'concurrent_limit');
  end if;

  v_remaining := p_tier_cap_seconds - v_committed - v_reserved_sum;
  v_from_inc := least(p_max_grant_seconds, greatest(0, v_remaining));
  v_from_bon := 0;

  select coalesce(sum(seconds_remaining), 0) into v_bonus_pool
  from voice_bonus_grants
  where business_id = p_business_id
    and voided_at is null
    and expires_at > now();

  select coalesce(sum(reserved_bonus_seconds), 0) into v_bonus_inflight
  from voice_reservations
  where business_id = p_business_id and state in ('pending_answer', 'active');

  v_bonus_pool := greatest(0, v_bonus_pool - v_bonus_inflight);

  if v_from_inc < p_min_grant_seconds then
    v_need := p_min_grant_seconds - v_from_inc;
    v_from_bon := least(v_need, p_max_grant_seconds - v_from_inc, v_bonus_pool);
  end if;

  v_grant := v_from_inc + v_from_bon;

  if v_grant < p_min_grant_seconds then
    return jsonb_build_object(
      'ok', false,
      'reason', 'quota_exhausted',
      'remaining_seconds', v_remaining,
      'bonus_seconds_available', v_bonus_pool
    );
  end if;

  v_left := v_from_bon;
  if v_left > 0 then
    for gr in
      select id, seconds_remaining
      from voice_bonus_grants
      where business_id = p_business_id
        and voided_at is null
        and expires_at > now()
        and seconds_remaining > 0
      order by expires_at asc, purchased_at asc
      for update
    loop
      exit when v_left <= 0;
      select coalesce(sum((je.chunk->>'seconds')::int), 0) into v_inflight_gr
      from voice_reservations vr
      cross join lateral jsonb_array_elements(vr.bonus_grant_allocations) as je(chunk)
      where vr.business_id = p_business_id
        and vr.state in ('pending_answer', 'active')
        and vr.bonus_grant_allocations is not null
        and jsonb_typeof(vr.bonus_grant_allocations) = 'array'
        and (je.chunk->>'grant_id')::uuid = gr.id;

      v_eff := gr.seconds_remaining - v_inflight_gr;
      if v_eff <= 0 then
        continue;
      end if;
      chunk := least(v_left, v_eff);
      v_alloc := v_alloc || jsonb_build_array(
        jsonb_build_object('grant_id', gr.id, 'seconds', chunk)
      );
      v_left := v_left - chunk;
    end loop;
  end if;

  if v_from_bon > 0 and v_left > 0 then
    return jsonb_build_object(
      'ok', false,
      'reason', 'quota_exhausted',
      'remaining_seconds', v_remaining,
      'bonus_seconds_available', v_bonus_pool
    );
  end if;

  insert into voice_reservations (
    business_id,
    call_control_id,
    state,
    reserved_total_seconds,
    stripe_period_start_key,
    reserved_included_seconds,
    reserved_bonus_seconds,
    bonus_grant_allocations
  ) values (
    p_business_id,
    p_call_control_id,
    'pending_answer',
    v_grant,
    p_stripe_period_start,
    v_from_inc,
    v_from_bon,
    case when v_from_bon > 0 then v_alloc else null end
  )
  returning * into v_row;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'grant_seconds', v_grant,
    'reservation_id', v_row.id
  );
exception
  when unique_violation then
    select * into v_row from voice_reservations where call_control_id = p_call_control_id;
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'grant_seconds', v_row.reserved_total_seconds,
      'reservation_id', v_row.id
    );
end;
$$;

grant execute on function voice_reserve_for_call(uuid, text, text, integer, timestamptz, integer, integer, integer)
  to service_role;

create or replace function voice_try_finalize_settlement(
  p_call_control_id text,
  p_allow_one_sided boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
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

  wall_cap := floor(elapsed)::int;
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

  commit_inc := least(billable, r.reserved_included_seconds);
  commit_bon := least(billable - commit_inc, r.reserved_bonus_seconds);

  if commit_bon > 0 then
    if r.bonus_grant_allocations is not null and jsonb_typeof(r.bonus_grant_allocations) = 'array'
       and jsonb_array_length(r.bonus_grant_allocations) > 0 then
      v_bon_took := consume_voice_bonus_from_allocations(
        r.business_id,
        r.bonus_grant_allocations,
        commit_bon
      );
      if v_bon_took <> commit_bon then
        return jsonb_build_object(
          'ok', false,
          'reason', 'bonus_allocation_shortfall',
          'commit_bon_expected', commit_bon,
          'bonus_grants_debited_seconds', v_bon_took
        );
      end if;
    else
      perform consume_voice_bonus_seconds(r.business_id, commit_bon);
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
