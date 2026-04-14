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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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
  billable_seconds integer,
  finalized_at timestamptz,
  settlement_idempotency_key text unique,
  created_at timestamptz not null default now()
);

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
-- Webhook + SMS queue
-- ---------------------------------------------------------------------------
create table if not exists telnyx_webhook_events (
  event_id uuid primary key,
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sms_inbound_jobs_pending on sms_inbound_jobs (status, created_at);

alter table sms_inbound_jobs enable row level security;

create policy "Service role manages sms_inbound_jobs"
  on sms_inbound_jobs for all
  using (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- RPC: idempotent webhook insert — returns true if this is the first time
-- ---------------------------------------------------------------------------
create or replace function telnyx_webhook_try_dedupe(p_event_id uuid, p_event_type text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into telnyx_webhook_events (event_id, event_type)
  values (p_event_id, p_event_type);
  return true;
exception
  when unique_violation then
    return false;
end;
$$;

grant execute on function telnyx_webhook_try_dedupe(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- RPC: reserve seconds + enforce concurrency (§4) — included pool only v1
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
  v_grant int;
  v_row voice_reservations%rowtype;
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
  v_grant := least(p_max_grant_seconds, greatest(0, v_remaining));

  if v_grant < p_min_grant_seconds then
    return jsonb_build_object(
      'ok', false,
      'reason', 'quota_exhausted',
      'remaining_seconds', v_remaining
    );
  end if;

  insert into voice_reservations (
    business_id,
    call_control_id,
    state,
    reserved_total_seconds,
    stripe_period_start_key,
    reserved_included_seconds,
    reserved_bonus_seconds
  ) values (
    p_business_id,
    p_call_control_id,
    'pending_answer',
    v_grant,
    p_stripe_period_start,
    v_grant,
    0
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

-- Mark reservation active after successful answer (Edge calls this).
create or replace function voice_mark_answer_issued(p_call_control_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update voice_reservations
  set state = 'active', answer_issued_at = coalesce(answer_issued_at, now()), updated_at = now()
  where call_control_id = p_call_control_id and state = 'pending_answer';
end;
$$;

grant execute on function voice_mark_answer_issued(text) to service_role;

create or replace function voice_release_reservation_on_answer_fail(p_call_control_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update voice_reservations
  set state = 'released', updated_at = now()
  where call_control_id = p_call_control_id and state = 'pending_answer';
end;
$$;

grant execute on function voice_release_reservation_on_answer_fail(text) to service_role;
