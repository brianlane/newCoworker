-- Usage packs: purchasable SMS text packs + Gemini (chat-model) spend credit
-- packs, mirroring the voice bonus pack pipeline end to end
-- (20260420100000_voice_telnyx_platform.sql §4.1).
--
--   * sms_bonus_grants: bonus outbound texts consumed AFTER the plan's
--     monthly cap (750 starter / 3000 standard). try_reserve_sms_outbound_slot
--     spills over into the bonus balance instead of hard-blocking.
--   * chat_spend_credit_grants: purchased credit that RAISES the shared
--     Gemini spend cap (owner dashboard chat + SMS, owner_chat_model_spend)
--     for as long as the credit is active. Cap checks become
--     base cap + chat_active_credit_micros(business).
--   * usage_cap_alerts: once-per-period guard so the first cap hit sends a
--     single urgent owner notification instead of silence (or spam).
--
-- Expiry follows the voice rule: max(billing period end, purchased_at + 30d),
-- computed app-side in the Stripe webhook. Refund / dispute-lost clawback
-- mirrors void_voice_bonus_grant_by_checkout_session (partial refunds reduce
-- proportionally; disputes void fully).

-- ---------------------------------------------------------------------------
-- SMS bonus grants
-- ---------------------------------------------------------------------------
create table if not exists sms_bonus_grants (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  stripe_checkout_session_id text unique,
  texts_purchased integer not null,
  texts_remaining integer not null,
  purchased_at timestamptz not null default now(),
  expires_at timestamptz not null,
  voided_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_sms_bonus_grants_business on sms_bonus_grants (business_id);

alter table sms_bonus_grants enable row level security;

drop policy if exists "Service role manages sms_bonus_grants" on sms_bonus_grants;
create policy "Service role manages sms_bonus_grants"
  on sms_bonus_grants for all
  using (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- Chat (Gemini) spend credit grants
-- ---------------------------------------------------------------------------
create table if not exists chat_spend_credit_grants (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  stripe_checkout_session_id text unique,
  credit_micros_purchased bigint not null,
  -- Active (clawback-adjusted) amount. Unlike voice/SMS grants this is NOT
  -- consumed per turn — it raises the period cap while the grant is active;
  -- only refunds/disputes reduce it.
  credit_micros bigint not null,
  purchased_at timestamptz not null default now(),
  expires_at timestamptz not null,
  voided_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_spend_credit_grants_business
  on chat_spend_credit_grants (business_id);

alter table chat_spend_credit_grants enable row level security;

drop policy if exists "Service role manages chat_spend_credit_grants" on chat_spend_credit_grants;
create policy "Service role manages chat_spend_credit_grants"
  on chat_spend_credit_grants for all
  using (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- Idempotent grant-from-checkout RPCs (mirror apply_voice_bonus_grant_from_checkout)
-- ---------------------------------------------------------------------------
create or replace function apply_sms_bonus_grant_from_checkout(
  p_business_id uuid,
  p_checkout_session_id text,
  p_texts_purchased integer,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
  v_texts int := greatest(0, p_texts_purchased);
begin
  if p_checkout_session_id is null or length(trim(p_checkout_session_id)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'missing_session_id');
  end if;
  if v_texts <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_texts');
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

  insert into sms_bonus_grants (
    business_id,
    stripe_checkout_session_id,
    texts_purchased,
    texts_remaining,
    expires_at
  )
  values (p_business_id, trim(p_checkout_session_id), v_texts, v_texts, p_expires_at)
  on conflict (stripe_checkout_session_id) do nothing
  returning id into v_id;

  if v_id is not null then
    return jsonb_build_object('ok', true, 'grant_id', v_id, 'duplicate', false);
  end if;

  select id into v_id
  from sms_bonus_grants
  where stripe_checkout_session_id = trim(p_checkout_session_id)
  limit 1;

  return jsonb_build_object('ok', true, 'grant_id', v_id, 'duplicate', true);
end;
$$;

revoke execute on function apply_sms_bonus_grant_from_checkout(uuid, text, integer, timestamptz) from public;
grant execute on function apply_sms_bonus_grant_from_checkout(uuid, text, integer, timestamptz) to service_role;

create or replace function apply_chat_credit_grant_from_checkout(
  p_business_id uuid,
  p_checkout_session_id text,
  p_credit_micros bigint,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
  v_micros bigint := greatest(0, p_credit_micros);
begin
  if p_checkout_session_id is null or length(trim(p_checkout_session_id)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'missing_session_id');
  end if;
  if v_micros <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_credit');
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

  insert into chat_spend_credit_grants (
    business_id,
    stripe_checkout_session_id,
    credit_micros_purchased,
    credit_micros,
    expires_at
  )
  values (p_business_id, trim(p_checkout_session_id), v_micros, v_micros, p_expires_at)
  on conflict (stripe_checkout_session_id) do nothing
  returning id into v_id;

  if v_id is not null then
    return jsonb_build_object('ok', true, 'grant_id', v_id, 'duplicate', false);
  end if;

  select id into v_id
  from chat_spend_credit_grants
  where stripe_checkout_session_id = trim(p_checkout_session_id)
  limit 1;

  return jsonb_build_object('ok', true, 'grant_id', v_id, 'duplicate', true);
end;
$$;

revoke execute on function apply_chat_credit_grant_from_checkout(uuid, text, bigint, timestamptz) from public;
grant execute on function apply_chat_credit_grant_from_checkout(uuid, text, bigint, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Clawback RPCs (mirror void_voice_bonus_grant_by_checkout_session semantics:
-- NULL clawback = full void, 0 = no-op, N>0 = partial reduce, idempotent)
-- ---------------------------------------------------------------------------
create or replace function public.void_sms_bonus_grant_by_checkout_session(
  p_checkout_session_id text,
  p_reason text default 'refund',
  p_clawback_texts integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r public.sms_bonus_grants%rowtype;
  v_claw integer;
  v_new_remaining integer;
  v_full boolean;
begin
  if p_checkout_session_id is null or length(trim(p_checkout_session_id)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'missing_session_id');
  end if;

  select * into r from public.sms_bonus_grants
  where stripe_checkout_session_id = trim(p_checkout_session_id)
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'grant_not_found');
  end if;

  if r.voided_at is not null then
    return jsonb_build_object(
      'ok', true,
      'already_voided', true,
      'grant_id', r.id,
      'business_id', r.business_id,
      'texts_remaining_at_void', r.texts_remaining
    );
  end if;

  if p_clawback_texts is not null and p_clawback_texts <= 0 then
    return jsonb_build_object(
      'ok', true,
      'already_voided', false,
      'no_op', true,
      'grant_id', r.id,
      'business_id', r.business_id,
      'texts_remaining_at_void', r.texts_remaining,
      'reason', coalesce(nullif(trim(p_reason), ''), 'refund')
    );
  end if;

  if p_clawback_texts is null or p_clawback_texts >= r.texts_remaining then
    v_claw := r.texts_remaining;
    v_new_remaining := 0;
    v_full := true;
  else
    v_claw := p_clawback_texts;
    v_new_remaining := r.texts_remaining - p_clawback_texts;
    v_full := false;
  end if;

  update public.sms_bonus_grants
  set
    texts_remaining = v_new_remaining,
    voided_at = case when v_full then now() else voided_at end
  where id = r.id;

  return jsonb_build_object(
    'ok', true,
    'already_voided', false,
    'grant_id', r.id,
    'business_id', r.business_id,
    'texts_remaining_at_void', r.texts_remaining,
    'texts_clawed_back', v_claw,
    'texts_remaining_after', v_new_remaining,
    'partial', not v_full,
    'reason', coalesce(nullif(trim(p_reason), ''), 'refund')
  );
end;
$$;

revoke execute on function public.void_sms_bonus_grant_by_checkout_session(text, text, integer) from public;
grant execute on function public.void_sms_bonus_grant_by_checkout_session(text, text, integer) to service_role;

create or replace function public.void_chat_credit_grant_by_checkout_session(
  p_checkout_session_id text,
  p_reason text default 'refund',
  p_clawback_micros bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r public.chat_spend_credit_grants%rowtype;
  v_claw bigint;
  v_new_active bigint;
  v_full boolean;
begin
  if p_checkout_session_id is null or length(trim(p_checkout_session_id)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'missing_session_id');
  end if;

  select * into r from public.chat_spend_credit_grants
  where stripe_checkout_session_id = trim(p_checkout_session_id)
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'grant_not_found');
  end if;

  if r.voided_at is not null then
    return jsonb_build_object(
      'ok', true,
      'already_voided', true,
      'grant_id', r.id,
      'business_id', r.business_id,
      'credit_micros_at_void', r.credit_micros
    );
  end if;

  if p_clawback_micros is not null and p_clawback_micros <= 0 then
    return jsonb_build_object(
      'ok', true,
      'already_voided', false,
      'no_op', true,
      'grant_id', r.id,
      'business_id', r.business_id,
      'credit_micros_at_void', r.credit_micros,
      'reason', coalesce(nullif(trim(p_reason), ''), 'refund')
    );
  end if;

  if p_clawback_micros is null or p_clawback_micros >= r.credit_micros then
    v_claw := r.credit_micros;
    v_new_active := 0;
    v_full := true;
  else
    v_claw := p_clawback_micros;
    v_new_active := r.credit_micros - p_clawback_micros;
    v_full := false;
  end if;

  update public.chat_spend_credit_grants
  set
    credit_micros = v_new_active,
    voided_at = case when v_full then now() else voided_at end
  where id = r.id;

  return jsonb_build_object(
    'ok', true,
    'already_voided', false,
    'grant_id', r.id,
    'business_id', r.business_id,
    'credit_micros_at_void', r.credit_micros,
    'credit_micros_clawed_back', v_claw,
    'credit_micros_after', v_new_active,
    'partial', not v_full,
    'reason', coalesce(nullif(trim(p_reason), ''), 'refund')
  );
end;
$$;

revoke execute on function public.void_chat_credit_grant_by_checkout_session(text, text, bigint) from public;
grant execute on function public.void_chat_credit_grant_by_checkout_session(text, text, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- Active chat credit (read by cap checks: edge worker, VPS chat worker, UI)
-- ---------------------------------------------------------------------------
create or replace function public.chat_active_credit_micros(p_business_id uuid)
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(sum(g.credit_micros), 0)::bigint
  from public.chat_spend_credit_grants g
  where g.business_id = p_business_id
    and g.voided_at is null
    and g.expires_at > now();
$$;

revoke execute on function public.chat_active_credit_micros(uuid) from public;
grant execute on function public.chat_active_credit_micros(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- SMS bonus remaining (read by the billing page)
-- ---------------------------------------------------------------------------
create or replace function public.sms_bonus_texts_remaining(p_business_id uuid)
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(sum(g.texts_remaining), 0)::bigint
  from public.sms_bonus_grants g
  where g.business_id = p_business_id
    and g.voided_at is null
    and g.expires_at > now();
$$;

revoke execute on function public.sms_bonus_texts_remaining(uuid) from public;
grant execute on function public.sms_bonus_texts_remaining(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Reserve spillover: consume bonus texts after the plan cap
-- ---------------------------------------------------------------------------
-- Same contract as before plus:
--   {'ok': true, 'source': 'plan'}   — under the monthly cap (or uncapped tier)
--   {'ok': true, 'source': 'bonus'}  — over cap, one bonus text consumed
--   {'ok': false, 'reason': 'monthly_sms_limit'} — over cap, no bonus left
-- daily_usage.sms_sent is incremented for BONUS sends too (it is the usage
-- ledger for digests/quota UIs); the cap check naturally keeps spilling into
-- bonus once v_used >= v_limit.
create or replace function public.try_reserve_sms_outbound_slot(p_business_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tier text;
  v_ent jsonb;
  v_limit bigint;
  v_used bigint;
  v_today_utc date := (now() at time zone 'utc')::date;
  v_month_start date := date_trunc('month', (now() at time zone 'utc'))::date;
  v_source text := 'plan';
  v_grant_id uuid;
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
    select coalesce(sum(du.sms_sent), 0)::bigint
    into v_used
    from public.daily_usage du
    where du.business_id = p_business_id
      and du.usage_date >= v_month_start;

    if v_used >= v_limit then
      -- Plan cap reached: spill into the purchased bonus balance
      -- (earliest-expiring grant first, matching consume_voice_bonus_seconds).
      update public.sms_bonus_grants g
      set texts_remaining = g.texts_remaining - 1
      where g.id = (
        select g2.id
        from public.sms_bonus_grants g2
        where g2.business_id = p_business_id
          and g2.voided_at is null
          and g2.expires_at > now()
          and g2.texts_remaining > 0
        order by g2.expires_at asc, g2.purchased_at asc
        limit 1
        for update
      )
      returning g.id into v_grant_id;

      if v_grant_id is null then
        return jsonb_build_object('ok', false, 'reason', 'monthly_sms_limit');
      end if;
      v_source := 'bonus';
    end if;
  end if;

  -- Use UTC calendar date (matches v_month_start). Using session-local current_date here
  -- created a subtle drift where a send crossing midnight UTC in a non-UTC session would
  -- write into a daily_usage row not counted in the next-window monthly aggregation.
  insert into public.daily_usage (
    business_id,
    usage_date,
    voice_minutes_used,
    sms_sent,
    calls_made,
    peak_concurrent_calls,
    updated_at
  )
  values (p_business_id, v_today_utc, 0, 1, 0, 0, now())
  on conflict (business_id, usage_date) do update set
    sms_sent = public.daily_usage.sms_sent + 1,
    updated_at = now();

  return jsonb_build_object('ok', true, 'source', v_source);
end;
$$;

grant execute on function public.try_reserve_sms_outbound_slot(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Release: optionally refund a bonus text consumed by the matching reserve
-- ---------------------------------------------------------------------------
-- Signature change (uuid) → (uuid, boolean default false) requires an explicit
-- drop; existing one-arg callers keep working through the default.
drop function if exists public.release_sms_outbound_slot(uuid);

create or replace function public.release_sms_outbound_slot(
  p_business_id uuid,
  p_refund_bonus boolean default false
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_today_utc date := (now() at time zone 'utc')::date;
  v_updated int;
begin
  update public.daily_usage du
  set
    sms_sent = greatest(0, du.sms_sent - 1),
    updated_at = now()
  where du.business_id = p_business_id
    and du.usage_date = v_today_utc
    and du.sms_sent > 0;
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    update public.daily_usage du
    set
      sms_sent = greatest(0, du.sms_sent - 1),
      updated_at = now()
    where du.ctid = (
      select ctid
      from public.daily_usage
      where business_id = p_business_id
        and sms_sent > 0
        and usage_date >= v_today_utc - interval '2 days'
      order by usage_date desc
      limit 1
      for update
    );
  end if;

  -- Refund the bonus text the failed send consumed. We can't know the exact
  -- grant the reserve debited, so credit the earliest-expiring active grant —
  -- the same one the NEXT reserve would debit, so balances stay correct in
  -- aggregate. If every grant expired/voided in between, the refund is
  -- dropped (acceptable: one text on an already-dead grant).
  if p_refund_bonus then
    update public.sms_bonus_grants g
    set texts_remaining = least(g.texts_purchased, g.texts_remaining + 1)
    where g.id = (
      select g2.id
      from public.sms_bonus_grants g2
      where g2.business_id = p_business_id
        and g2.voided_at is null
        and g2.expires_at > now()
      order by g2.expires_at asc, g2.purchased_at asc
      limit 1
      for update
    );
  end if;
end;
$$;

revoke execute on function public.release_sms_outbound_slot(uuid, boolean) from public;
grant execute on function public.release_sms_outbound_slot(uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Once-per-period cap-alert guard
-- ---------------------------------------------------------------------------
create table if not exists usage_cap_alerts (
  business_id uuid not null references businesses(id) on delete cascade,
  -- 'sms_monthly' | 'chat_spend'
  cap_kind text not null,
  -- Period identifier: UTC month start date for SMS, Stripe period-start ISO
  -- for chat spend. Plain text so both keys fit one guard table.
  period_key text not null,
  created_at timestamptz not null default now(),
  primary key (business_id, cap_kind, period_key)
);

alter table usage_cap_alerts enable row level security;

drop policy if exists "Service role manages usage_cap_alerts" on usage_cap_alerts;
create policy "Service role manages usage_cap_alerts"
  on usage_cap_alerts for all
  using (auth.role() = 'service_role');

-- Returns true exactly once per (business, cap kind, period): the caller that
-- gets true sends the urgent owner notification; everyone else skips.
create or replace function public.mark_usage_cap_alert(
  p_business_id uuid,
  p_cap_kind text,
  p_period_key text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count int;
begin
  insert into public.usage_cap_alerts (business_id, cap_kind, period_key)
  values (p_business_id, p_cap_kind, p_period_key)
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke execute on function public.mark_usage_cap_alert(uuid, text, text) from public;
grant execute on function public.mark_usage_cap_alert(uuid, text, text) to service_role;
