-- §9.1 dual-signal finalize, §4 bonus pool (reserve + commit, FIFO grants + allocations),
-- §10 SMS job claim, §11 sweep, §14 telemetry (+ retention RPC).
-- Telnyx: voice_settlements.telnyx_reported_duration_seconds caps billable at finalize.

-- ---------------------------------------------------------------------------
-- Telemetry (§14) — lightweight event sink for Edge/app counters
-- ---------------------------------------------------------------------------
create table if not exists telemetry_events (
  id bigserial primary key,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_telemetry_events_type_created
  on telemetry_events (event_type, created_at desc);

alter table telemetry_events enable row level security;

create policy "Service role manages telemetry_events"
  on telemetry_events for all
  using (auth.role() = 'service_role');

create or replace function telemetry_record(p_event_type text, p_payload jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into telemetry_events (event_type, payload) values (p_event_type, coalesce(p_payload, '{}'::jsonb));
$$;

grant execute on function telemetry_record(text, jsonb) to service_role;

create or replace function telemetry_prune_events(p_max_age interval default interval '90 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  delete from telemetry_events where created_at < now() - p_max_age;
  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function telemetry_prune_events(interval) to service_role;

comment on function telemetry_prune_events(interval) is
  'Deletes telemetry_events older than p_max_age. Run periodically in production.';

-- ---------------------------------------------------------------------------
-- Carrier-reported duration (Telnyx call.hangup payload.call_duration seconds)
-- ---------------------------------------------------------------------------
alter table voice_settlements
  add column if not exists telnyx_reported_duration_seconds integer;

comment on column voice_settlements.telnyx_reported_duration_seconds is
  'When set, billable_seconds caps at least(wall-clock billable, this value) at finalize.';

-- ---------------------------------------------------------------------------
-- Bonus consumption (actual charge at finalize)
-- ---------------------------------------------------------------------------
create or replace function consume_voice_bonus_seconds(p_business_id uuid, p_take integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  remaining int := greatest(0, p_take);
  chunk int;
  took int := 0;
begin
  if remaining <= 0 then
    return 0;
  end if;
  for r in
    select id, seconds_remaining
    from voice_bonus_grants
    where business_id = p_business_id
      and voided_at is null
      and expires_at > now()
      and seconds_remaining > 0
    order by expires_at asc, purchased_at asc
    for update
  loop
    exit when remaining <= 0;
    chunk := least(r.seconds_remaining, remaining);
    update voice_bonus_grants
    set seconds_remaining = seconds_remaining - chunk
    where id = r.id;
    took := took + chunk;
    remaining := remaining - chunk;
  end loop;
  return took;
end;
$$;

grant execute on function consume_voice_bonus_seconds(uuid, integer) to service_role;

-- Debit bonus using explicit per-grant chunks from reserve (FIFO order in JSON array).
create or replace function consume_voice_bonus_from_allocations(
  p_business_id uuid,
  p_allocations jsonb,
  p_take integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining int := greatest(0, p_take);
  took int := 0;
  i int;
  n int;
  elem jsonb;
  gid uuid;
  allot int;
  cap int;
  chunk int;
  sv int;
begin
  if remaining <= 0 or p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    return 0;
  end if;
  n := jsonb_array_length(p_allocations);
  if n is null or n <= 0 then
    return 0;
  end if;
  for i in 0 .. n - 1 loop
    exit when remaining <= 0;
    elem := p_allocations->i;
    if elem is null or jsonb_typeof(elem) <> 'object' then
      continue;
    end if;
    begin
      gid := (elem->>'grant_id')::uuid;
    exception
      when invalid_text_representation then continue;
    end;
    if gid is null then
      continue;
    end if;
    allot := greatest(0, coalesce((elem->>'seconds')::int, 0));
    cap := least(remaining, allot);
    if cap <= 0 then
      continue;
    end if;
    select seconds_remaining into sv
    from voice_bonus_grants
    where id = gid and business_id = p_business_id
      and voided_at is null
      and expires_at > now()
    for update;
    if not found or sv <= 0 then
      continue;
    end if;
    chunk := least(cap, sv);
    update voice_bonus_grants
    set seconds_remaining = seconds_remaining - chunk
    where id = gid;
    took := took + chunk;
    remaining := remaining - chunk;
  end loop;
  return took;
end;
$$;

grant execute on function consume_voice_bonus_from_allocations(uuid, jsonb, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Replace reservation RPC: included + optional bonus (grants charged at finalize)
-- ---------------------------------------------------------------------------
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

  select coalesce(sum(reserved_total_seconds), 0) into v_reserved_sum
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

-- ---------------------------------------------------------------------------
-- Finalize settlement (§9.1) — both signals, or one-sided when sweep allows
-- ---------------------------------------------------------------------------
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
  v_bon_rest int;
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
      v_bon_rest := commit_bon - v_bon_took;
      if v_bon_rest > 0 then
        perform consume_voice_bonus_seconds(r.business_id, v_bon_rest);
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

-- Bridge WS close → second signal + finalize when Telnyx already recorded end
create or replace function voice_record_bridge_media_end(p_call_control_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business uuid;
  v_reservation uuid;
  now_ts timestamptz := now();
begin
  select business_id, id into v_business, v_reservation
  from voice_reservations
  where call_control_id = p_call_control_id and state in ('pending_answer', 'active')
  limit 1;

  if v_business is null then
    select business_id into v_business from voice_active_sessions where call_control_id = p_call_control_id;
  end if;

  if v_business is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_call');
  end if;

  insert into voice_settlements (call_control_id, business_id, reservation_id, bridge_media_ended_at, first_signal_at)
  values (p_call_control_id, v_business, v_reservation, now_ts, now_ts)
  on conflict (call_control_id) do update set
    business_id = excluded.business_id,
    bridge_media_ended_at = coalesce(voice_settlements.bridge_media_ended_at, now_ts),
    first_signal_at = least(voice_settlements.first_signal_at, excluded.first_signal_at),
    reservation_id = coalesce(voice_settlements.reservation_id, excluded.reservation_id);

  return voice_try_finalize_settlement(p_call_control_id, false);
end;
$$;

grant execute on function voice_record_bridge_media_end(text) to service_role;

-- §11 sweep: finalize rows stuck waiting for a second signal
create or replace function voice_sweep_stale_settlements(p_min_age text default '15 minutes')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  rec record;
  j jsonb;
  v_iv interval := cast(p_min_age as interval);
begin
  for rec in
    select call_control_id
    from voice_settlements
    where finalized_at is null
      and first_signal_at is not null
      and first_signal_at < now() - v_iv
  loop
    j := voice_try_finalize_settlement(rec.call_control_id, true);
    if coalesce((j->>'ok')::boolean, false) then
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

grant execute on function voice_sweep_stale_settlements(text) to service_role;

-- ---------------------------------------------------------------------------
-- SMS inbound job claim (§10)
-- ---------------------------------------------------------------------------
alter table sms_inbound_jobs
  add column if not exists telnyx_outbound_message_id text,
  add column if not exists rowboat_conversation_id text,
  add column if not exists last_error text;

create or replace function claim_sms_inbound_jobs(p_limit integer default 5)
returns setof sms_inbound_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with cte as (
    select id
    from sms_inbound_jobs
    where status = 'pending'
    order by created_at
    for update skip locked
    limit greatest(1, least(p_limit, 50))
  )
  update sms_inbound_jobs j
  set
    status = 'processing',
    processing_started_at = now(),
    attempt_count = j.attempt_count + 1,
    updated_at = now()
  from cte
  where j.id = cte.id
  returning j.*;
end;
$$;

grant execute on function claim_sms_inbound_jobs(integer) to service_role;

create or replace function complete_sms_inbound_job(
  p_job_id uuid,
  p_status text,
  p_telnyx_outbound_message_id text default null,
  p_rowboat_conversation_id text default null,
  p_last_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('done', 'dead_letter', 'pending') then
    raise exception 'invalid status %', p_status;
  end if;
  update sms_inbound_jobs
  set
    status = p_status,
    telnyx_outbound_message_id = coalesce(p_telnyx_outbound_message_id, telnyx_outbound_message_id),
    rowboat_conversation_id = coalesce(p_rowboat_conversation_id, rowboat_conversation_id),
    last_error = p_last_error,
    updated_at = now()
  where id = p_job_id;
end;
$$;

grant execute on function complete_sms_inbound_job(uuid, text, text, text, text) to service_role;
