-- Auto-reload for usage packs: settings, authorized card, ledger, and the
-- claim/settle RPCs the sweep drives.
--
-- When a tenant's remaining capacity falls below a threshold they set, we
-- charge the card they explicitly authorized and grant a pack, the same shape
-- as Telnyx auto-recharge and Google AI Studio auto-reload. The grant itself
-- reuses the existing apply_*_grant_from_checkout RPCs keyed
-- `pi_<paymentIntentId>`, so no new grant path is introduced.
--
-- Three tables:
--   usage_pack_auto_reload_cards   one authorized card per business
--   usage_pack_auto_reload_rules   one rule per (business, category)
--   usage_pack_auto_reload_events  ledger AND claim (the unique attempt_key
--                                  is what makes a concurrent double-charge
--                                  impossible)
--
-- Balance math is deliberately NOT in SQL. The chat cap needs an env-derived
-- per-tier base and the SMS cap needs the TS clamp helpers, so re-deriving
-- either here would create a second copy of an enforcement contract. The
-- candidates RPC is a cheap prefilter; the caller computes balances with the
-- existing readers and then claims.

-- ---------------------------------------------------------------------------
-- Authorized card (one per business, shared by all three families)
-- ---------------------------------------------------------------------------
-- The membership card was collected under a SUBSCRIPTION mandate, which does
-- not cover ad-hoc merchant-initiated top-ups. Auto-reload therefore requires
-- its own authorization through a mode=setup Checkout, and we record who
-- consented, when, and to which copy version, because that record is what we
-- produce if a tenant disputes an unattended charge.
create table if not exists public.usage_pack_auto_reload_cards (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  stripe_payment_method_id text not null,
  card_brand text,
  card_last4 text,
  card_exp_month integer,
  card_exp_year integer,
  consent_at timestamptz not null default now(),
  consent_user_id uuid,
  consent_ip inet,
  consent_text_version text not null default 'v1',
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.usage_pack_auto_reload_cards enable row level security;

drop policy if exists "Service role manages usage_pack_auto_reload_cards"
  on public.usage_pack_auto_reload_cards;
create policy "Service role manages usage_pack_auto_reload_cards"
  on public.usage_pack_auto_reload_cards for all
  using (auth.role() = 'service_role');

grant select, insert, update, delete
  on table public.usage_pack_auto_reload_cards to service_role;

-- ---------------------------------------------------------------------------
-- Rules: one row per business per family
-- ---------------------------------------------------------------------------
-- Per-category rows rather than one jsonb blob: every mutable field is
-- per-category (threshold, pack, monthly counter, failure count, in-flight
-- stamp), so a blob would force read-modify-write of all three families for
-- any single-category update and race the sweep against the tenant's Save.
-- Column checks are also real validation, which jsonb gives none of.
create table if not exists public.usage_pack_auto_reload_rules (
  business_id uuid not null references public.businesses(id) on delete cascade,
  category text not null check (category in ('voice', 'sms', 'chat')),
  enabled boolean not null default false,

  -- Canonical integer units: seconds / texts / micro-USD. The UI converts.
  threshold_units bigint not null check (threshold_units > 0),

  -- Catalog pack id. Not FK-checked: the catalog is env-derived and fails
  -- closed at read time, so the app is the authority on availability.
  pack_id text not null check (length(btrim(pack_id)) between 1 and 40),

  -- Optional ceiling on auto-reload spend per UTC calendar month.
  -- NULL means no tenant ceiling (the platform env ceiling still applies).
  monthly_limit_cents integer check (monthly_limit_cents is null or monthly_limit_cents > 0),
  month_key text not null default to_char(timezone('utc', now()), 'YYYY-MM'),
  month_spent_cents integer not null default 0 check (month_spent_cents >= 0),
  month_charges integer not null default 0 check (month_charges >= 0),

  cooldown_minutes integer not null default 60
    check (cooldown_minutes between 5 and 1440),

  in_flight_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),

  -- Paused: recoverable, `enabled` stays true (3DS, budget reached).
  -- Disabled: `enabled` flips false (repeated hard declines, dispute, cancel).
  paused_at timestamptz,
  paused_reason text,
  disabled_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, category)
);

create index if not exists idx_usage_pack_auto_reload_rules_due
  on public.usage_pack_auto_reload_rules (category, last_attempt_at)
  where enabled and paused_at is null;

alter table public.usage_pack_auto_reload_rules enable row level security;

drop policy if exists "Service role manages usage_pack_auto_reload_rules"
  on public.usage_pack_auto_reload_rules;
create policy "Service role manages usage_pack_auto_reload_rules"
  on public.usage_pack_auto_reload_rules for all
  using (auth.role() = 'service_role');

grant select, insert, update, delete
  on table public.usage_pack_auto_reload_rules to service_role;

-- ---------------------------------------------------------------------------
-- Events: the tenant-visible ledger, and the claim
-- ---------------------------------------------------------------------------
-- `attempt_key` is '<business>:<category>:<floor(epoch / cooldown)>'. The
-- unique index on it is the atomicity primitive: two overlapping sweep ticks
-- both insert, one wins, the loser gets `already_claimed` and charges nothing.
-- Same shape as uq_spend_velocity_alerts_bucket in
-- 20260711002041_spend_velocity_alerts.sql.
create table if not exists public.usage_pack_auto_reload_events (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  category text not null check (category in ('voice', 'sms', 'chat')),
  pack_id text not null,
  amount_cents integer not null check (amount_cents >= 0),
  -- Charge currency, from the Stripe Price. Stored (not re-derived) because a
  -- resumed attempt must replay the ORIGINAL parameters: the Stripe
  -- idempotency key is derived from this row, and Stripe rejects a reused key
  -- whose parameters changed.
  currency text not null default 'usd',
  -- Grant size actually applied, in canonical units. Null until settled.
  units_granted bigint,
  balance_units_at_trigger bigint not null,
  threshold_units bigint not null,
  status text not null check (status in (
    'pending',
    'succeeded',
    'failed',
    'requires_action',
    'abandoned',
    'skipped_monthly_limit',
    'skipped_pack_unavailable',
    'skipped_no_card',
    'skipped_inactive_subscription'
  )),
  failure_code text,
  failure_message text,
  stripe_payment_intent_id text,
  grant_source_id text,
  attempt_key text not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

create unique index if not exists uq_usage_pack_auto_reload_events_attempt
  on public.usage_pack_auto_reload_events (attempt_key);

create index if not exists idx_usage_pack_auto_reload_events_business
  on public.usage_pack_auto_reload_events (business_id, created_at desc);

alter table public.usage_pack_auto_reload_events enable row level security;

drop policy if exists "Service role manages usage_pack_auto_reload_events"
  on public.usage_pack_auto_reload_events;
create policy "Service role manages usage_pack_auto_reload_events"
  on public.usage_pack_auto_reload_events for all
  using (auth.role() = 'service_role');

-- Identity column: no sequence grant needed (supabase/migrations/CLAUDE.md).
grant select, insert, update, delete
  on table public.usage_pack_auto_reload_events to service_role;

-- ---------------------------------------------------------------------------
-- Candidates: a cheap prefilter, no balance math
-- ---------------------------------------------------------------------------
create or replace function public.usage_pack_auto_reload_candidates(p_limit integer default 200)
returns table (
  business_id uuid,
  category text,
  pack_id text,
  threshold_units bigint,
  monthly_limit_cents integer,
  cooldown_minutes integer,
  owner_email text,
  business_name text,
  tier text,
  enterprise_limits jsonb,
  phone text,
  timezone text,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_period_start timestamptz,
  stripe_payment_method_id text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    r.business_id,
    r.category,
    r.pack_id,
    r.threshold_units,
    r.monthly_limit_cents,
    r.cooldown_minutes,
    b.owner_email,
    b.name,
    b.tier,
    b.enterprise_limits,
    b.phone,
    b.timezone,
    s.stripe_customer_id,
    s.stripe_subscription_id,
    s.stripe_current_period_start,
    c.stripe_payment_method_id
  from public.usage_pack_auto_reload_rules r
  join public.businesses b on b.id = r.business_id
  join public.subscriptions s on s.business_id = r.business_id
  join public.usage_pack_auto_reload_cards c on c.business_id = r.business_id
  where r.enabled
    and r.paused_at is null
    and c.revoked_at is null
    and s.status = 'active'
    and s.stripe_subscription_id is not null
    -- Cooldown elapsed.
    and (
      r.last_attempt_at is null
      or r.last_attempt_at < now() - make_interval(mins => r.cooldown_minutes)
    )
    -- No fresh in-flight charge. A crashed run leaves the stamp behind, so
    -- it ages out rather than wedging the rule forever.
    and (r.in_flight_at is null or r.in_flight_at < now() - interval '15 minutes')
  order by r.last_attempt_at asc nulls first
  limit greatest(1, coalesce(p_limit, 200));
$$;

revoke execute on function public.usage_pack_auto_reload_candidates(integer) from public;
grant execute on function public.usage_pack_auto_reload_candidates(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Resume: reclaim a stale in-flight attempt instead of minting a new one
-- ---------------------------------------------------------------------------
-- Critical for double-charge safety. The Stripe idempotency key is derived
-- from the event id, so a retry MUST reuse the same row: a new row would mean
-- a new key, and Stripe would happily create a second PaymentIntent for a
-- charge that may already have succeeded.
create or replace function public.usage_pack_auto_reload_resume_stale(
  p_business_id uuid,
  p_category text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  e public.usage_pack_auto_reload_events%rowtype;
begin
  select * into e
  from public.usage_pack_auto_reload_events
  where business_id = p_business_id
    and category = p_category
    and status = 'pending'
    and created_at < now() - interval '15 minutes'
  order by created_at asc
  limit 1
  for update skip locked;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'none');
  end if;

  -- Stripe idempotency keys expire after 24 hours. Past that window a retry
  -- is no longer protected against duplicating the charge, so the attempt is
  -- abandoned rather than resumed.
  if e.created_at < now() - interval '24 hours' then
    update public.usage_pack_auto_reload_events
    set status = 'abandoned',
        failure_code = 'idempotency_window_expired',
        settled_at = now()
    where id = e.id;

    update public.usage_pack_auto_reload_rules
    set in_flight_at = null,
        month_spent_cents = greatest(0, month_spent_cents - e.amount_cents),
        month_charges = greatest(0, month_charges - 1),
        updated_at = now()
    where business_id = p_business_id and category = p_category;

    return jsonb_build_object('ok', false, 'reason', 'abandoned', 'event_id', e.id);
  end if;

  update public.usage_pack_auto_reload_rules
  set in_flight_at = now(), updated_at = now()
  where business_id = p_business_id and category = p_category;

  return jsonb_build_object(
    'ok', true,
    'event_id', e.id,
    'pack_id', e.pack_id,
    'amount_cents', e.amount_cents,
    'currency', e.currency
  );
end;
$$;

revoke execute on function public.usage_pack_auto_reload_resume_stale(uuid, text) from public;
grant execute on function public.usage_pack_auto_reload_resume_stale(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Claim: month rollover, budget check, and the atomic attempt insert
-- ---------------------------------------------------------------------------
-- `cooldown_minutes` is read from the ROW, not passed in, so a tenant editing
-- their cooldown cannot shift the bucket boundary and buy an extra charge in
-- the transition window.
create or replace function public.usage_pack_auto_reload_claim(
  p_business_id uuid,
  p_category text,
  p_pack_id text,
  p_amount_cents integer,
  p_balance_units bigint,
  p_threshold_units bigint,
  p_platform_max_cents integer default null,
  p_currency text default 'usd'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r public.usage_pack_auto_reload_rules%rowtype;
  v_now timestamptz := now();
  v_month text := to_char(timezone('utc', v_now), 'YYYY-MM');
  v_spent integer;
  v_charges integer;
  v_limit bigint;
  v_key text;
  v_event_id bigint;
begin
  select * into r
  from public.usage_pack_auto_reload_rules
  where business_id = p_business_id and category = p_category
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_settings');
  end if;
  if not r.enabled or r.paused_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;

  -- Month rollover resets both counters inside the same lock.
  if r.month_key is distinct from v_month then
    v_spent := 0;
    v_charges := 0;
  else
    v_spent := r.month_spent_cents;
    v_charges := r.month_charges;
  end if;

  -- Tenant ceiling clamped by the platform ceiling. Either may be null.
  v_limit := least(
    coalesce(r.monthly_limit_cents::bigint, 9223372036854775807),
    coalesce(p_platform_max_cents::bigint, 9223372036854775807)
  );

  if v_spent::bigint + p_amount_cents::bigint > v_limit then
    update public.usage_pack_auto_reload_rules
    set month_key = v_month,
        month_spent_cents = v_spent,
        month_charges = v_charges,
        paused_at = v_now,
        paused_reason = 'monthly_limit_reached',
        updated_at = v_now
    where business_id = p_business_id and category = p_category;
    return jsonb_build_object('ok', false, 'reason', 'monthly_limit');
  end if;

  v_key := p_business_id::text || ':' || p_category || ':' ||
    floor(extract(epoch from v_now) / greatest(1, r.cooldown_minutes * 60))::bigint::text;

  insert into public.usage_pack_auto_reload_events (
    business_id, category, pack_id, amount_cents, currency,
    balance_units_at_trigger, threshold_units, status, attempt_key
  )
  values (
    p_business_id, p_category, p_pack_id, p_amount_cents, coalesce(p_currency, 'usd'),
    p_balance_units, p_threshold_units, 'pending', v_key
  )
  on conflict (attempt_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return jsonb_build_object('ok', false, 'reason', 'already_claimed');
  end if;

  -- Reserve the budget BEFORE charging. A failed charge refunds it in the
  -- settle RPC; a crashed run leaks at most one slot, which is the safe
  -- direction to fail.
  update public.usage_pack_auto_reload_rules
  set month_key = v_month,
      month_spent_cents = v_spent + p_amount_cents,
      month_charges = v_charges + 1,
      in_flight_at = v_now,
      last_attempt_at = v_now,
      updated_at = v_now
  where business_id = p_business_id and category = p_category;

  return jsonb_build_object('ok', true, 'event_id', v_event_id, 'attempt_key', v_key);
end;
$$;

revoke execute on function public.usage_pack_auto_reload_claim(
  uuid, text, text, integer, bigint, bigint, integer, text
) from public;
grant execute on function public.usage_pack_auto_reload_claim(
  uuid, text, text, integer, bigint, bigint, integer, text
) to service_role;

-- ---------------------------------------------------------------------------
-- Settle: close the attempt and move the rule's state machine
-- ---------------------------------------------------------------------------
create or replace function public.usage_pack_auto_reload_settle(
  p_event_id bigint,
  p_status text,
  p_units_granted bigint default null,
  p_failure_kind text default null,
  p_failure_code text default null,
  p_failure_message text default null,
  p_payment_intent_id text default null,
  p_grant_source_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  e public.usage_pack_auto_reload_events%rowtype;
  v_now timestamptz := now();
  v_charged boolean;
  v_disabled boolean := false;
  v_failures integer;
begin
  select * into e
  from public.usage_pack_auto_reload_events
  where id = p_event_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_event');
  end if;
  if e.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_settled');
  end if;

  update public.usage_pack_auto_reload_events
  set status = p_status,
      units_granted = p_units_granted,
      failure_code = p_failure_code,
      failure_message = left(coalesce(p_failure_message, ''), 500),
      stripe_payment_intent_id = p_payment_intent_id,
      grant_source_id = p_grant_source_id,
      settled_at = v_now
  where id = p_event_id;

  -- Money only actually left the account on success. Everything else has to
  -- give the reserved budget back, or a run of declines would silently eat a
  -- tenant's monthly allowance without ever buying them anything.
  v_charged := (p_status = 'succeeded');

  select consecutive_failures into v_failures
  from public.usage_pack_auto_reload_rules
  where business_id = e.business_id and category = e.category;

  if p_status = 'succeeded' then
    update public.usage_pack_auto_reload_rules
    set in_flight_at = null,
        last_success_at = v_now,
        consecutive_failures = 0,
        updated_at = v_now
    where business_id = e.business_id and category = e.category;

  elsif p_status = 'requires_action' then
    -- A bank challenge is not a decline: `enabled` stays true and the
    -- failure counter is untouched, because retrying off-session cannot
    -- help and counting it would disable well-behaved non-US cards.
    update public.usage_pack_auto_reload_rules
    set in_flight_at = null,
        month_spent_cents = greatest(0, month_spent_cents - e.amount_cents),
        month_charges = greatest(0, month_charges - 1),
        paused_at = v_now,
        paused_reason = 'authentication_required',
        updated_at = v_now
    where business_id = e.business_id and category = e.category;

  elsif p_status = 'failed' then
    -- Only failures that will not clear on their own count toward
    -- suspension; a soft decline retries next cooldown.
    if p_failure_kind = 'hard_decline' then
      v_failures := coalesce(v_failures, 0) + 1;
      v_disabled := v_failures >= 3;
    elsif p_failure_kind = 'no_payment_method' then
      v_disabled := true;
    end if;

    update public.usage_pack_auto_reload_rules
    set in_flight_at = null,
        month_spent_cents = greatest(0, month_spent_cents - e.amount_cents),
        month_charges = greatest(0, month_charges - 1),
        consecutive_failures = case
          when p_failure_kind = 'hard_decline' then v_failures
          else consecutive_failures
        end,
        enabled = case when v_disabled then false else enabled end,
        disabled_reason = case
          when v_disabled and p_failure_kind = 'no_payment_method' then 'no_payment_method'
          when v_disabled then 'payment_failures'
          else disabled_reason
        end,
        paused_at = case when v_disabled then v_now else paused_at end,
        paused_reason = case
          when v_disabled and p_failure_kind = 'no_payment_method' then 'no_payment_method'
          when v_disabled then 'payment_failures'
          else paused_reason
        end,
        updated_at = v_now
    where business_id = e.business_id and category = e.category;

  else
    -- Any skipped_* status: nothing was attempted, so give the budget back
    -- and leave the failure counter alone.
    update public.usage_pack_auto_reload_rules
    set in_flight_at = null,
        month_spent_cents = greatest(0, month_spent_cents - e.amount_cents),
        month_charges = greatest(0, month_charges - 1),
        updated_at = v_now
    where business_id = e.business_id and category = e.category;
  end if;

  return jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'charged', v_charged,
    'disabled', v_disabled
  );
end;
$$;

revoke execute on function public.usage_pack_auto_reload_settle(
  bigint, text, bigint, text, text, text, text, text
) from public;
grant execute on function public.usage_pack_auto_reload_settle(
  bigint, text, bigint, text, text, text, text, text
) to service_role;

-- ---------------------------------------------------------------------------
-- Disable every rule for a business (subscription canceled, dispute)
-- ---------------------------------------------------------------------------
-- A chargeback on an unattended charge is the customer telling us they did
-- not expect it. Continuing to auto-charge them after that is how this
-- becomes a Stripe risk review, so a dispute disables and revokes the card.
create or replace function public.usage_pack_auto_reload_disable_for_business(
  p_business_id uuid,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  update public.usage_pack_auto_reload_rules
  set enabled = false,
      disabled_reason = p_reason,
      paused_at = now(),
      paused_reason = p_reason,
      in_flight_at = null,
      updated_at = now()
  where business_id = p_business_id
    and (enabled or disabled_reason is distinct from p_reason);
  get diagnostics v_count = row_count;

  if p_reason = 'dispute' then
    update public.usage_pack_auto_reload_cards
    set revoked_at = now(), updated_at = now()
    where business_id = p_business_id and revoked_at is null;
  end if;

  return v_count;
end;
$$;

revoke execute on function public.usage_pack_auto_reload_disable_for_business(uuid, text) from public;
grant execute on function public.usage_pack_auto_reload_disable_for_business(uuid, text) to service_role;
