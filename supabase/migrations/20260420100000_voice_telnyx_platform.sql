-- Voice + Telnyx + SMS platform (single migration).
-- Replaces the former chain: 20260414120000 … 20260419120000 (see git history).
--
-- Apply on a fresh database or after `supabase db reset`. If you already applied any of the
-- replaced migrations in an environment, do not run this file blindly — repair or reset first.

-- Telnyx voice routing, billing-period quota, reservations, SMS queue, webhook dedupe.
-- Service role owns writes; RLS mirrors existing patterns.

-- ---------------------------------------------------------------------------
-- Stripe subscription cache (JIT refresh from app; §4.2)
-- ---------------------------------------------------------------------------
alter table subscriptions
  add column if not exists stripe_current_period_start timestamptz,
  add column if not exists stripe_current_period_end timestamptz,
  add column if not exists stripe_subscription_cached_at timestamptz;

create index if not exists idx_subscriptions_business_id on subscriptions (business_id);

-- ---------------------------------------------------------------------------
-- Per-business Telnyx + bridge routing
-- ---------------------------------------------------------------------------
create table if not exists business_telnyx_settings (
  business_id uuid primary key references businesses(id) on delete cascade,
  telnyx_messaging_profile_id text,
  telnyx_sms_from_e164 text,
  telnyx_connection_id text,
  bridge_media_wss_origin text,
  bridge_media_path text not null default '/voice/stream',
  bridge_last_heartbeat_at timestamptz,
  bridge_last_error_at timestamptz,
  bridge_error_message text,
  updated_at timestamptz not null default now()
);

alter table business_telnyx_settings enable row level security;

create policy "Service role manages business_telnyx_settings"
  on business_telnyx_settings for all
  using (auth.role() = 'service_role');

create policy "Owner reads own telnyx settings"
  on business_telnyx_settings for select
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

-- DID → business + media path (Edge traffic cop §1)
create table if not exists telnyx_voice_routes (
  to_e164 text primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  media_wss_origin text,
  media_path text not null default '/voice/stream',
  created_at timestamptz not null default now()
);

create index if not exists idx_telnyx_voice_routes_business on telnyx_voice_routes (business_id);

alter table telnyx_voice_routes enable row level security;

create policy "Service role manages telnyx_voice_routes"
  on telnyx_voice_routes for all
  using (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- Voice billing period usage (included pool §4)
-- ---------------------------------------------------------------------------
create table if not exists voice_billing_period_usage (
  business_id uuid not null references businesses(id) on delete cascade,
  stripe_period_start timestamptz not null,
  tier_cap_seconds integer not null default 600,
  committed_included_seconds integer not null default 0,
  low_balance_alert_armed boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (business_id, stripe_period_start)
);

alter table voice_billing_period_usage enable row level security;

create policy "Service role manages voice_billing_period_usage"
  on voice_billing_period_usage for all
  using (auth.role() = 'service_role');

create policy "Owner reads own voice usage"
  on voice_billing_period_usage for select
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

-- ---------------------------------------------------------------------------
-- Bonus grants (a la carte §4.1) — minimal shape; expand in app layer
-- ---------------------------------------------------------------------------
create table if not exists voice_bonus_grants (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  stripe_checkout_session_id text unique,
  seconds_purchased integer not null,
  seconds_remaining integer not null,
  purchased_at timestamptz not null default now(),
  expires_at timestamptz not null,
  voided_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_voice_bonus_grants_business on voice_bonus_grants (business_id);

alter table voice_bonus_grants enable row level security;

create policy "Service role manages voice_bonus_grants"
  on voice_bonus_grants for all
  using (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- Serialization lock for quota (§4)
-- ---------------------------------------------------------------------------
create table if not exists business_voice_quota_lock (
  business_id uuid primary key references businesses(id) on delete cascade
);

alter table business_voice_quota_lock enable row level security;

create policy "Service role manages voice_quota_lock"
  on business_voice_quota_lock for all
  using (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- Reservations + active media sessions
-- ---------------------------------------------------------------------------
create table if not exists voice_reservations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  call_control_id text not null unique,
  state text not null check (state in ('pending_answer', 'active', 'released', 'settled')),
  reserved_total_seconds integer not null,
  stripe_period_start_key timestamptz not null,
  reserved_included_seconds integer not null default 0,
  reserved_bonus_seconds integer not null default 0,
  bonus_grant_allocations jsonb,
  answer_issued_at timestamptz,
  ws_connected_at timestamptz,
  voice_failover_maintenance_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column voice_reservations.voice_failover_maintenance_at is
  'Set when telnyx-voice-failover maintenance speak ran; prevents duplicate scripted messages for the same leg.';

create index if not exists idx_voice_reservations_business_state
  on voice_reservations (business_id, state);

alter table voice_reservations enable row level security;

create policy "Service role manages voice_reservations"
  on voice_reservations for all
  using (auth.role() = 'service_role');

create table if not exists voice_active_sessions (
  call_control_id text primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  stream_nonce text,
  media_started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz
);

create index if not exists idx_voice_active_sessions_business on voice_active_sessions (business_id);

alter table voice_active_sessions enable row level security;

create policy "Service role manages voice_active_sessions"
  on voice_active_sessions for all
  using (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- Dual-signal settlement (§9.1)
-- ---------------------------------------------------------------------------
create table if not exists voice_settlements (
  call_control_id text primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  reservation_id uuid references voice_reservations(id),
  telnyx_ended_at timestamptz,
  bridge_media_ended_at timestamptz,
  first_signal_at timestamptz,
  /* Telnyx call.hangup / call.ended payload call_duration (seconds); caps billable at finalize. */
  telnyx_reported_duration_seconds integer,
  billable_seconds integer,
  finalized_at timestamptz,
  settlement_idempotency_key text unique,
  created_at timestamptz not null default now()
);

comment on column voice_settlements.telnyx_reported_duration_seconds is
  'When set, billable_seconds caps at least(wall-clock billable, this value) at finalize.';

alter table voice_settlements enable row level security;

create policy "Service role manages voice_settlements"
  on voice_settlements for all
  using (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- Stream URL nonces (§2)
-- ---------------------------------------------------------------------------
create table if not exists stream_url_nonces (
  nonce text primary key,
  consumed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_stream_url_nonces_expires on stream_url_nonces (expires_at);

alter table stream_url_nonces enable row level security;

create policy "Service role manages stream_url_nonces"
  on stream_url_nonces for all
  using (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- Webhook + SMS queue (event_id is Telnyx opaque string, e.g. evt_..., not UUID)
-- ---------------------------------------------------------------------------
create table if not exists telnyx_webhook_events (
  event_id text primary key,
  event_type text,
  received_at timestamptz not null default now()
);

alter table telnyx_webhook_events enable row level security;

create policy "Service role manages telnyx_webhook_events"
  on telnyx_webhook_events for all
  using (auth.role() = 'service_role');

create table if not exists sms_inbound_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  telnyx_event_id text,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'dead_letter')),
  outbound_idempotency_key uuid,
  processing_started_at timestamptz,
  attempt_count integer not null default 0,
  telnyx_outbound_message_id text,
  rowboat_conversation_id text,
  /* Cached assistant reply when Rowboat succeeded but Telnyx send must retry (avoid duplicate /chat). */
  rowboat_reply_cached text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sms_inbound_jobs_pending on sms_inbound_jobs (status, created_at);

alter table sms_inbound_jobs enable row level security;

create policy "Service role manages sms_inbound_jobs"
  on sms_inbound_jobs for all
  using (auth.role() = 'service_role');
-- Per-business overrides for enterprise tier (merged with TIER_LIMITS.enterprise in app + Edge).
alter table public.businesses
  add column if not exists enterprise_limits jsonb;

comment on column public.businesses.enterprise_limits is
  'Optional JSON overrides for enterprise TierLimits keys: voiceMinutesPerDay, voiceIncludedSecondsPerStripePeriod, smsPerMonth (legacy smsPerDay accepted and converted in app), maxConcurrentCalls, smsThrottled. Omitted keys use code defaults.';
-- §9.1 dual-signal finalize, §4 bonus pool (reserve + commit, FIFO grants + allocations),
-- §10 SMS job claim, §11 sweep, §14 telemetry (+ retention RPC).

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
-- Multi-turn SMS: persist Rowboat conversation + workflow state per business + customer E.164.

create table if not exists sms_rowboat_threads (
  business_id uuid not null references businesses(id) on delete cascade,
  customer_e164 text not null,
  rowboat_conversation_id text not null,
  rowboat_state jsonb,
  updated_at timestamptz not null default now(),
  primary key (business_id, customer_e164)
);

create index if not exists idx_sms_rowboat_threads_updated on sms_rowboat_threads (updated_at desc);

alter table sms_rowboat_threads enable row level security;

create policy "Service role manages sms_rowboat_threads"
  on sms_rowboat_threads for all
  using (auth.role() = 'service_role');

create policy "Owner reads own sms_rowboat_threads"
  on sms_rowboat_threads for select
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );
-- Inworld.ai removed; voice is Telnyx + VPS bridge.
alter table public.business_configs
  drop column if exists inworld_agent_id;
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
-- §7: Per-IP webhook rate buckets (Postgres-backed; survives cold Edge isolates).
-- Concurrent Telnyx deliveries: claim_until single-flight per event_id (FOR UPDATE).

alter table telnyx_webhook_events
  add column if not exists claim_until timestamptz;

comment on column telnyx_webhook_events.claim_until is
  'In-flight lease: while > now(), telnyx_webhook_try_begin returns busy. Cleared in telnyx_webhook_mark_complete.';

create table if not exists telnyx_webhook_ip_rate (
  route_bucket text not null,
  window_epoch bigint not null,
  hit_count int not null default 0,
  primary key (route_bucket, window_epoch)
);

create index if not exists idx_telnyx_webhook_ip_rate_prune
  on telnyx_webhook_ip_rate (window_epoch);

alter table telnyx_webhook_ip_rate enable row level security;

create policy "Service role manages telnyx_webhook_ip_rate"
  on telnyx_webhook_ip_rate for all
  using (auth.role() = 'service_role');

create or replace function telnyx_webhook_rate_check(
  p_ip text,
  p_route text,
  p_max_per_window int default 240,
  p_window_seconds int default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  key text := md5(
    coalesce(nullif(trim(p_ip), ''), 'unknown') || ':' || coalesce(nullif(trim(p_route), ''), 'all')
  );
  w bigint := (
    floor(extract(epoch from clock_timestamp()) / greatest(p_window_seconds, 1)) * greatest(p_window_seconds, 1)
  )::bigint;
  cnt int;
begin
  if p_max_per_window <= 0 then
    return jsonb_build_object('ok', true, 'disabled', true);
  end if;

  insert into telnyx_webhook_ip_rate (route_bucket, window_epoch, hit_count)
  values (key, w, 1)
  on conflict (route_bucket, window_epoch)
  do update set hit_count = telnyx_webhook_ip_rate.hit_count + 1
  returning hit_count into cnt;

  delete from telnyx_webhook_ip_rate
  where window_epoch < (extract(epoch from clock_timestamp())::bigint - 86400);

  if cnt > p_max_per_window then
    return jsonb_build_object('ok', false, 'hits', cnt, 'max', p_max_per_window);
  end if;
  return jsonb_build_object('ok', true, 'hits', cnt);
end;
$$;

grant execute on function telnyx_webhook_rate_check(text, text, integer, integer) to service_role;

create or replace function telnyx_webhook_try_begin(p_event_id text, p_event_type text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r telnyx_webhook_events%rowtype;
  claim_ttl interval := interval '2 minutes';
begin
  if p_event_id is null or length(trim(p_event_id)) = 0 then
    return jsonb_build_object('status', 'error', 'reason', 'missing_event_id');
  end if;

  insert into telnyx_webhook_events (event_id, event_type)
  values (p_event_id, p_event_type)
  on conflict (event_id) do nothing;

  select * into r from telnyx_webhook_events where event_id = p_event_id for update;
  if not found then
    return jsonb_build_object('status', 'error', 'reason', 'no_row');
  end if;

  if r.completed_at is not null then
    return jsonb_build_object('status', 'done');
  end if;

  if r.claim_until is not null and r.claim_until > now() then
    return jsonb_build_object('status', 'busy');
  end if;

  update telnyx_webhook_events
  set
    claim_until = now() + claim_ttl,
    event_type = case
      when p_event_type is not null and length(trim(p_event_type)) > 0 then p_event_type
      else telnyx_webhook_events.event_type
    end
  where event_id = p_event_id;

  return jsonb_build_object('status', 'work');
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
  set
    completed_at = coalesce(completed_at, now()),
    claim_until = null
  where event_id = p_event_id and completed_at is null;
$$;

grant execute on function telnyx_webhook_mark_complete(text) to service_role;

drop function if exists telnyx_webhook_try_dedupe(text, text);
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

comment on function public.complete_sms_inbound_job(uuid, text, text, text, text) is
  'Marks an inbound SMS job done, dead_letter, or pending. Status pending is intentional: the worker resets failed Telnyx sends to pending for bounded retries (see sms-inbound-worker).';

-- Single SQL source for Starter/Standard monthly SMS caps (starter = non-standard tier).
-- Must match supabase/functions/_shared/sms_monthly_limits.ts and src/lib/plans/limits.ts.

create or replace function public.nonenterprise_monthly_sms_cap(p_tier text)
returns bigint
language sql
immutable
parallel safe
as $$
  select case p_tier
    when 'standard' then 3000::bigint
    else 750::bigint
  end;
$$;

-- Resolved monthly SMS cap: null means unlimited (enterprise default or no numeric override).
create or replace function public.monthly_sms_cap_for_business(p_tier text, p_ent jsonb)
returns bigint
language plpgsql
immutable
parallel safe
as $$
declare
  v_limit bigint;
  v_day numeric;
  v_month numeric;
begin
  if p_tier = 'enterprise' then
    v_limit := null;
    if p_ent is not null then
      if p_ent ? 'smsPerMonth' and jsonb_typeof(p_ent->'smsPerMonth') = 'number' then
        v_month := (p_ent->>'smsPerMonth')::numeric;
        if v_month > 0 and v_month < 1e15 then
          v_limit := floor(v_month)::bigint;
        end if;
      elsif p_ent ? 'smsPerDay' and jsonb_typeof(p_ent->'smsPerDay') = 'number' then
        v_day := (p_ent->>'smsPerDay')::numeric;
        if v_day > 0 and v_day < 1e15 then
          v_limit := greatest(1::bigint, round(v_day * 30)::bigint);
        end if;
      end if;
    end if;
    return v_limit;
  end if;

  if p_tier in ('starter', 'standard') then
    return public.nonenterprise_monthly_sms_cap(p_tier);
  end if;

  return public.nonenterprise_monthly_sms_cap('starter');
end;
$$;

-- Under row lock on businesses: enforce monthly cap and pre-increment sms_sent before outbound Telnyx send (app + notifications).
-- If Telnyx fails, call release_sms_outbound_slot. Pair with complete_sms_inbound_job (done only) on workers that reserve first (future).
create or replace function public.try_reserve_sms_outbound_slot(p_business_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier text;
  v_ent jsonb;
  v_limit bigint;
  v_used bigint;
  v_month_start date;
begin
  select b.tier, b.enterprise_limits
  into v_tier, v_ent
  from public.businesses b
  where b.id = p_business_id
  for update;

  if v_tier is null then
    return jsonb_build_object('ok', false, 'reason', 'no_business');
  end if;

  v_limit := public.monthly_sms_cap_for_business(v_tier, v_ent);

  if v_limit is not null then
    v_month_start := (date_trunc('month', (now() at time zone 'utc'))::date);

    select coalesce(sum(du.sms_sent), 0)::bigint
    into v_used
    from public.daily_usage du
    where du.business_id = p_business_id
      and du.usage_date >= v_month_start;

    if v_used >= v_limit then
      return jsonb_build_object('ok', false, 'reason', 'monthly_sms_limit');
    end if;
  end if;

  insert into public.daily_usage (
    business_id,
    usage_date,
    voice_minutes_used,
    sms_sent,
    calls_made,
    peak_concurrent_calls,
    updated_at
  )
  values (
    p_business_id,
    current_date,
    0,
    1,
    0,
    0,
    now()
  )
  on conflict (business_id, usage_date) do update set
    sms_sent = public.daily_usage.sms_sent + 1,
    updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

-- Undo try_reserve_sms_outbound_slot when Telnyx send fails after a successful reserve.
create or replace function public.release_sms_outbound_slot(p_business_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.daily_usage du
  set
    sms_sent = greatest(0, du.sms_sent - 1),
    updated_at = now()
  where du.business_id = p_business_id
    and du.usage_date = current_date;
end;
$$;

grant execute on function public.try_reserve_sms_outbound_slot(uuid) to service_role;
grant execute on function public.release_sms_outbound_slot(uuid) to service_role;

-- Atomically mark job done and increment sms_sent (same transaction). Call only after Telnyx send succeeds.
create or replace function public.complete_sms_inbound_job_done_meter_sms(
  p_job_id uuid,
  p_business_id uuid,
  p_telnyx_outbound_message_id text,
  p_rowboat_conversation_id text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  update public.sms_inbound_jobs j
  set
    status = 'done',
    telnyx_outbound_message_id = coalesce(nullif(trim(p_telnyx_outbound_message_id), ''), j.telnyx_outbound_message_id),
    rowboat_conversation_id = coalesce(p_rowboat_conversation_id, j.rowboat_conversation_id),
    last_error = null,
    updated_at = now()
  where j.id = p_job_id
    and j.business_id = p_business_id;

  get diagnostics v_updated = ROW_COUNT;
  if v_updated <> 1 then
    raise exception 'complete_sms_inbound_job_done_meter_sms: job % not found or business mismatch', p_job_id;
  end if;

  insert into public.daily_usage (
    business_id,
    usage_date,
    voice_minutes_used,
    sms_sent,
    calls_made,
    peak_concurrent_calls,
    updated_at
  )
  values (
    p_business_id,
    current_date,
    0,
    1,
    0,
    0,
    now()
  )
  on conflict (business_id, usage_date) do update set
    sms_sent = public.daily_usage.sms_sent + 1,
    updated_at = now();
end;
$$;

grant execute on function public.complete_sms_inbound_job_done_meter_sms(uuid, uuid, text, text) to service_role;

-- Monthly SMS quota check for Edge workers (mirrors app getTierLimits + getCalendarMonthUsageTotals).

create or replace function public.check_sms_monthly_limit(p_business_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier text;
  v_ent jsonb;
  v_limit bigint;
  v_used bigint;
  v_month_start date;
begin
  select b.tier, b.enterprise_limits
  into v_tier, v_ent
  from public.businesses b
  where b.id = p_business_id;

  if v_tier is null then
    return jsonb_build_object('allowed', false, 'reason', 'no_business');
  end if;

  v_limit := public.monthly_sms_cap_for_business(v_tier, v_ent);

  if v_limit is null then
    return jsonb_build_object('allowed', true);
  end if;

  v_month_start := (date_trunc('month', (now() at time zone 'utc'))::date);

  select coalesce(sum(du.sms_sent), 0)::bigint
  into v_used
  from public.daily_usage du
  where du.business_id = p_business_id
    and du.usage_date >= v_month_start;

  if v_used >= v_limit then
    return jsonb_build_object('allowed', false, 'reason', 'monthly_sms_limit');
  end if;

  return jsonb_build_object('allowed', true);
end;
$$;

grant execute on function public.check_sms_monthly_limit(uuid) to service_role;

-- §4.1 bonus checkout (subscription + expiry enforced in app), low-balance re-arm + email targets,
-- §8 failover maintenance claim, §11 sweeps (zombie finalize, reservations, SMS reclaim).

-- ---------------------------------------------------------------------------
-- Idempotent bonus grant from Stripe Checkout (payment mode, metadata-driven)
-- ---------------------------------------------------------------------------
create or replace function apply_voice_bonus_grant_from_checkout(
  p_business_id uuid,
  p_checkout_session_id text,
  p_seconds_purchased integer,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_sec int := greatest(0, p_seconds_purchased);
begin
  if p_checkout_session_id is null or length(trim(p_checkout_session_id)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'missing_session_id');
  end if;
  if v_sec <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_seconds');
  end if;

  if not exists (
    select 1
    from subscriptions s
    where s.business_id = p_business_id
      and s.status = 'active'
      and s.stripe_subscription_id is not null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'no_active_subscription');
  end if;

  insert into voice_bonus_grants (
    business_id,
    stripe_checkout_session_id,
    seconds_purchased,
    seconds_remaining,
    expires_at
  )
  values (
    p_business_id,
    trim(p_checkout_session_id),
    v_sec,
    v_sec,
    p_expires_at
  )
  on conflict (stripe_checkout_session_id) do nothing
  returning id into v_id;

  if v_id is not null then
    return jsonb_build_object('ok', true, 'grant_id', v_id, 'duplicate', false);
  end if;

  select id into v_id
  from voice_bonus_grants
  where stripe_checkout_session_id = trim(p_checkout_session_id)
  limit 1;

  return jsonb_build_object('ok', true, 'grant_id', v_id, 'duplicate', true);
end;
$$;

grant execute on function apply_voice_bonus_grant_from_checkout(uuid, text, integer, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- §4.1 Low included-pool headroom alert (Edge sends email when crossing threshold)
-- ---------------------------------------------------------------------------
create or replace function voice_list_low_balance_alert_targets(p_threshold_seconds integer default 300)
returns table (
  business_id uuid,
  owner_email text,
  stripe_period_start timestamptz,
  included_headroom_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thr int := greatest(0, p_threshold_seconds);
begin
  return query
  select
    u.business_id,
    b.owner_email::text,
    u.stripe_period_start,
    (
      u.tier_cap_seconds
      - u.committed_included_seconds
      - coalesce((
          select sum(r.reserved_included_seconds)::int
          from voice_reservations r
          where r.business_id = u.business_id
            and r.stripe_period_start_key = u.stripe_period_start
            and r.state in ('pending_answer', 'active')
        ), 0)
    )::integer as included_headroom_seconds
  from voice_billing_period_usage u
  join businesses b on b.id = u.business_id
  where u.low_balance_alert_armed
    and b.owner_email is not null
    and length(trim(b.owner_email::text)) > 0
    and (
      u.tier_cap_seconds
      - u.committed_included_seconds
      - coalesce((
          select sum(r.reserved_included_seconds)::int
          from voice_reservations r
          where r.business_id = u.business_id
            and r.stripe_period_start_key = u.stripe_period_start
            and r.state in ('pending_answer', 'active')
        ), 0)
    ) < v_thr;
end;
$$;

grant execute on function voice_list_low_balance_alert_targets(integer) to service_role;

create or replace function voice_mark_low_balance_alerts_sent(
  p_business_id uuid,
  p_stripe_period_start timestamptz
)
returns void
language sql
security definer
set search_path = public
as $$
  update voice_billing_period_usage
  set
    low_balance_alert_armed = false,
    updated_at = now()
  where business_id = p_business_id
    and stripe_period_start = p_stripe_period_start;
$$;

grant execute on function voice_mark_low_balance_alerts_sent(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- §4.1 Re-arm low_balance_alert_armed when included headroom rises above threshold
-- ---------------------------------------------------------------------------
create or replace function voice_sync_low_balance_alert_armed(p_threshold_seconds integer default 300)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
  v_thr int := greatest(0, p_threshold_seconds);
begin
  update voice_billing_period_usage u
  set
    low_balance_alert_armed = true,
    updated_at = now()
  from businesses b
  where u.business_id = b.id
    and (
      u.tier_cap_seconds
      - u.committed_included_seconds
      - coalesce((
          select sum(r.reserved_included_seconds)::int
          from voice_reservations r
          where r.business_id = u.business_id
            and r.stripe_period_start_key = u.stripe_period_start
            and r.state in ('pending_answer', 'active')
        ), 0)
    ) > v_thr;
  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function voice_sync_low_balance_alert_armed(integer) to service_role;

-- ---------------------------------------------------------------------------
-- §8 Idempotent maintenance speak claim (per reservation leg)
-- ---------------------------------------------------------------------------
create or replace function voice_claim_failover_maintenance_speak(p_call_control_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing timestamptz;
  v_n int;
begin
  if p_call_control_id is null or length(trim(p_call_control_id)) = 0 then
    return jsonb_build_object('ok', false, 'speak', false, 'reason', 'missing_call_control_id');
  end if;

  select voice_failover_maintenance_at into v_existing
  from voice_reservations
  where call_control_id = p_call_control_id
    and state in ('pending_answer', 'active')
  limit 1;

  if v_existing is not null then
    return jsonb_build_object('ok', true, 'speak', false, 'reason', 'already_spoken');
  end if;

  update voice_reservations
  set
    voice_failover_maintenance_at = now(),
    updated_at = now()
  where call_control_id = p_call_control_id
    and voice_failover_maintenance_at is null
    and state in ('pending_answer', 'active');
  get diagnostics v_n = row_count;

  if v_n > 0 then
    return jsonb_build_object('ok', true, 'speak', true, 'reason', 'claimed');
  end if;

  if not exists (select 1 from voice_reservations where call_control_id = p_call_control_id) then
    return jsonb_build_object('ok', true, 'speak', true, 'reason', 'no_reservation_tracking');
  end if;

  return jsonb_build_object('ok', true, 'speak', false, 'reason', 'reservation_not_active');
end;
$$;

grant execute on function voice_claim_failover_maintenance_speak(text) to service_role;

-- ---------------------------------------------------------------------------
-- §11 Additional sweeps
-- ---------------------------------------------------------------------------
create or replace function voice_sweep_zombie_active_sessions(p_stale interval default interval '15 minutes')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  rec record;
  v_res uuid;
  j jsonb;
begin
  for rec in
    select call_control_id, business_id, last_seen_at
    from voice_active_sessions
    where ended_at is null
      and last_seen_at < now() - p_stale
  loop
    v_res := null;
    select id into v_res
    from voice_reservations
    where call_control_id = rec.call_control_id
      and state in ('pending_answer', 'active')
    limit 1;

    insert into voice_settlements (
      call_control_id,
      business_id,
      reservation_id,
      bridge_media_ended_at,
      first_signal_at
    )
    values (
      rec.call_control_id,
      rec.business_id,
      v_res,
      rec.last_seen_at,
      rec.last_seen_at
    )
    on conflict (call_control_id) do update set
      bridge_media_ended_at = coalesce(
        voice_settlements.bridge_media_ended_at,
        excluded.bridge_media_ended_at
      ),
      first_signal_at = least(
        coalesce(voice_settlements.first_signal_at, excluded.first_signal_at),
        excluded.first_signal_at
      ),
      reservation_id = coalesce(voice_settlements.reservation_id, excluded.reservation_id);

    j := voice_try_finalize_settlement(rec.call_control_id, true);

    delete from voice_active_sessions where call_control_id = rec.call_control_id;
    n := n + 1;
  end loop;

  return n;
end;
$$;

grant execute on function voice_sweep_zombie_active_sessions(interval) to service_role;

create or replace function voice_sweep_stale_reservations(
  p_unanswered interval default interval '3 minutes',
  p_answer_no_ws interval default interval '10 minutes'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n1 int;
  n2 int;
begin
  update voice_reservations
  set state = 'released', updated_at = now()
  where state = 'pending_answer'
    and answer_issued_at is null
    and created_at < now() - p_unanswered;
  get diagnostics n1 = row_count;

  update voice_reservations
  set state = 'released', updated_at = now()
  where state in ('pending_answer', 'active')
    and answer_issued_at is not null
    and ws_connected_at is null
    and answer_issued_at < now() - p_answer_no_ws;
  get diagnostics n2 = row_count;

  return coalesce(n1, 0) + coalesce(n2, 0);
end;
$$;

grant execute on function voice_sweep_stale_reservations(interval, interval) to service_role;

create or replace function sms_reclaim_stale_processing_jobs(p_stale interval default interval '15 minutes')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  update sms_inbound_jobs
  set
    status = 'pending',
    processing_started_at = null,
    updated_at = now()
  where status = 'processing'
    and processing_started_at is not null
    and processing_started_at < now() - p_stale;
  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function sms_reclaim_stale_processing_jobs(interval) to service_role;

create or replace function voice_run_maintenance_sweeps(
  p_settlement_min_age text default '15 minutes',
  p_session_stale text default '15 minutes',
  p_res_unanswered text default '3 minutes',
  p_res_no_ws text default '10 minutes',
  p_sms_stale text default '15 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settlements int;
  v_sessions int;
  v_res int;
  v_sms int;
  v_sess interval := cast(p_session_stale as interval);
  v_ua interval := cast(p_res_unanswered as interval);
  v_nows interval := cast(p_res_no_ws as interval);
  v_sms_iv interval := cast(p_sms_stale as interval);
begin
  v_settlements := voice_sweep_stale_settlements(p_settlement_min_age);
  v_sessions := voice_sweep_zombie_active_sessions(v_sess);
  v_res := voice_sweep_stale_reservations(v_ua, v_nows);
  v_sms := sms_reclaim_stale_processing_jobs(v_sms_iv);
  return jsonb_build_object(
    'stale_settlements_finalized', v_settlements,
    'zombie_sessions_swept', v_sessions,
    'stale_reservations_released', v_res,
    'sms_jobs_reclaimed', v_sms
  );
end;
$$;

grant execute on function voice_run_maintenance_sweeps(text, text, text, text, text) to service_role;
