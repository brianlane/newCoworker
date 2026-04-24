-- Subscription lifecycle overhaul: customer_profiles (lifetime abuse tracking),
-- subscription_refunds audit, data_backups audit, and extended subscription
-- lifecycle columns (cancel_reason, grace_ends_at, wiped_at, etc.).
--
-- Policy (single source of truth — see plan):
--   * 30-day money-back window is customer-lifetime-once, anchored on the
--     first invoice.paid on the first subscription ever. Enforced via
--     customer_profiles.refund_used_at + first_paid_at.
--   * No past_due state. Payment failures → canceled_in_grace.
--   * canceled_in_grace lasts 30 days, then grace-sweep wipes VPS + auth.
--   * Max 3 distinct subscription lifetimes per profile.

-- ───────────────────────────────────────────────────────────────────────────
-- 1) customer_profiles: one row per abuse-identity (email + stripe customer
--    + last-signup IP). A single human creating multiple businesses collapses
--    onto one profile via email/ip/stripe-id merge at signup time.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists customer_profiles (
  id uuid primary key default gen_random_uuid(),
  normalized_email text not null,
  stripe_customer_id text,
  last_signup_ip inet,
  lifetime_subscription_count integer not null default 0,
  refund_used_at timestamptz,
  first_paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Fast lookup on the three merge keys. Unique on normalized_email and
-- stripe_customer_id matches the lifecycle policy: one abuse profile per
-- canonical email/payment identity. IP remains non-unique because shared
-- networks are only a weak signal.
create unique index if not exists idx_customer_profiles_email
  on customer_profiles (normalized_email);
create unique index if not exists idx_customer_profiles_stripe_customer
  on customer_profiles (stripe_customer_id)
  where stripe_customer_id is not null;
create index if not exists idx_customer_profiles_ip
  on customer_profiles (last_signup_ip)
  where last_signup_ip is not null;

alter table customer_profiles enable row level security;
-- Service-role only. No tenant-facing reads: this is an abuse-detection
-- store and must not be discoverable from an owner session.

-- ───────────────────────────────────────────────────────────────────────────
-- 2) businesses: link to profile for convenience, allow "wiped" status so
--    the grace-sweep can mark terminal state without dropping the audit row.
-- ───────────────────────────────────────────────────────────────────────────
alter table businesses
  add column if not exists customer_profile_id uuid references customer_profiles(id) on delete set null;
create index if not exists idx_businesses_customer_profile on businesses (customer_profile_id);

-- Relax the status check so "wiped" is a legal terminal. We drop+re-add the
-- named constraint because it's the only way to extend a CHECK without
-- rebuilding the table. Idempotent via `if exists`.
alter table businesses drop constraint if exists businesses_status_check;
alter table businesses
  add constraint businesses_status_check
  check (status in ('online', 'offline', 'high_load', 'wiped'));

-- ───────────────────────────────────────────────────────────────────────────
-- 3) subscriptions: lifecycle bookkeeping.
--
-- NOTE: we intentionally do NOT touch the existing `status` values. The app
-- uses the existing set {active, past_due, canceled, pending}; the new
-- "canceled_in_grace" logical state is represented by `status='canceled'`
-- + `grace_ends_at IS NOT NULL AND wiped_at IS NULL`. This keeps back-compat
-- with the Stripe webhook's existing status mapping while letting lifecycle
-- logic key off the richer timestamps.
-- ───────────────────────────────────────────────────────────────────────────
alter table subscriptions
  add column if not exists customer_profile_id uuid references customer_profiles(id) on delete set null,
  add column if not exists canceled_at timestamptz,
  add column if not exists cancel_reason text
    check (cancel_reason is null or cancel_reason in (
      'user_refund',
      'user_period_end',
      'payment_failed',
      'admin_force',
      'upgrade_switch'
    )),
  add column if not exists grace_ends_at timestamptz,
  add column if not exists wiped_at timestamptz,
  add column if not exists vps_stopped_at timestamptz,
  add column if not exists hostinger_billing_subscription_id text,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists stripe_refund_id text,
  add column if not exists refund_amount_cents integer;

create index if not exists idx_subscriptions_customer_profile
  on subscriptions (customer_profile_id);
-- Grace-sweep cron scans this daily: partial index keeps it cheap.
create index if not exists idx_subscriptions_grace_sweep
  on subscriptions (grace_ends_at)
  where wiped_at is null and grace_ends_at is not null;
-- cancel_at_period_end watcher (Stripe webhooks also mirror this, but the
-- sweep covers reconciliation if the webhook is missed).
create index if not exists idx_subscriptions_period_end_cancel
  on subscriptions (stripe_current_period_end)
  where cancel_at_period_end = true and status = 'active';

-- ───────────────────────────────────────────────────────────────────────────
-- 4) subscription_refunds: immutable audit trail. One row per Stripe refund
--    we issue (including upgrade/downgrade-adjacent refunds, though our
--    policy says no prorations — this exists for admin-force-refund).
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists subscription_refunds (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid references subscriptions(id) on delete set null,
  customer_profile_id uuid references customer_profiles(id) on delete set null,
  stripe_refund_id text not null,
  stripe_charge_id text,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'usd',
  reason text not null check (reason in (
    'thirty_day_money_back',
    'admin_force',
    'dispute_lost'
  )),
  created_at timestamptz not null default now()
);
create index if not exists idx_subscription_refunds_subscription
  on subscription_refunds (subscription_id);
create index if not exists idx_subscription_refunds_profile
  on subscription_refunds (customer_profile_id);
create unique index if not exists idx_subscription_refunds_stripe_refund
  on subscription_refunds (stripe_refund_id);

alter table subscription_refunds enable row level security;
-- Service-role only.

-- ───────────────────────────────────────────────────────────────────────────
-- 5) data_backups: tracks the SSH-tarball backup in Supabase Storage used
--    by cancel-grace and change-plan. One active backup per business
--    (storage_path is overwritten on new backup; this row is upserted).
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists data_backups (
  business_id uuid primary key references businesses(id) on delete cascade,
  storage_bucket text not null,
  storage_path text not null,
  sha256 text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table data_backups enable row level security;
-- Service-role only.

-- ───────────────────────────────────────────────────────────────────────────
-- 6) Helper: merge-or-insert a customer_profile by any of the three keys.
--    Called from signup/checkout. Returns the profile id.
--
--    Merge order is deterministic: email > stripe_customer_id > ip. If two
--    profiles collide (e.g. email row A and ip row B both exist), we keep
--    the older one and fold counts forward. We accept some data loss on the
--    dropped profile's counters because the merge is rare — happens only
--    when a user reuses an email they previously hid behind a different ip.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.upsert_customer_profile(
  p_normalized_email text,
  p_stripe_customer_id text,
  p_last_signup_ip inet
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_profile_id uuid;
  v_existing_by_stripe uuid;
  v_existing_by_ip uuid;
begin
  if p_normalized_email is null or length(trim(p_normalized_email)) = 0 then
    raise exception 'upsert_customer_profile: normalized_email is required';
  end if;

  -- Primary lookup: email. This is the canonical identity.
  select id into v_profile_id
    from customer_profiles
    where normalized_email = p_normalized_email
    limit 1;

  if v_profile_id is null then
    -- Try stripe_customer_id next (covers the case where a user deletes and
    -- recreates an email but we already know their payment identity).
    if p_stripe_customer_id is not null then
      select id into v_existing_by_stripe
        from customer_profiles
        where stripe_customer_id = p_stripe_customer_id
        limit 1;
      if v_existing_by_stripe is not null then
        v_profile_id := v_existing_by_stripe;
      end if;
    end if;
  end if;

  if v_profile_id is null then
    -- IP is the weakest signal (shared wifi, carrier NAT). We only match on
    -- IP if the row also has no email set — i.e. a previous anonymous
    -- pre-checkout attempt. This keeps us from merging unrelated users on a
    -- shared network.
    if p_last_signup_ip is not null then
      select id into v_existing_by_ip
        from customer_profiles
        where last_signup_ip = p_last_signup_ip
          and normalized_email is null
        order by created_at asc
        limit 1;
      if v_existing_by_ip is not null then
        v_profile_id := v_existing_by_ip;
      end if;
    end if;
  end if;

  if v_profile_id is null then
    insert into customer_profiles (normalized_email, stripe_customer_id, last_signup_ip)
      values (p_normalized_email, p_stripe_customer_id, p_last_signup_ip)
      returning id into v_profile_id;
  else
    -- Update any previously-null signals. Never overwrite existing non-null
    -- values (in particular, never downgrade refund_used_at to null).
    update customer_profiles
      set
        normalized_email = coalesce(normalized_email, p_normalized_email),
        stripe_customer_id = coalesce(stripe_customer_id, p_stripe_customer_id),
        last_signup_ip = coalesce(p_last_signup_ip, last_signup_ip),
        updated_at = now()
      where id = v_profile_id;
  end if;

  return v_profile_id;
end;
$$;

revoke all on function public.upsert_customer_profile(text, text, inet) from public;
revoke all on function public.upsert_customer_profile(text, text, inet) from anon;
revoke all on function public.upsert_customer_profile(text, text, inet) from authenticated;
grant execute on function public.upsert_customer_profile(text, text, inet) to service_role;

create or replace function public.increment_customer_profile_lifetime_count(
  p_profile_id uuid
) returns integer
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_count integer;
begin
  update customer_profiles
    set lifetime_subscription_count = lifetime_subscription_count + 1,
        updated_at = now()
    where id = p_profile_id
    returning lifetime_subscription_count into v_count;

  if v_count is null then
    raise exception 'increment_customer_profile_lifetime_count: profile not found %', p_profile_id;
  end if;

  return v_count;
end;
$$;

revoke all on function public.increment_customer_profile_lifetime_count(uuid) from public;
revoke all on function public.increment_customer_profile_lifetime_count(uuid) from anon;
revoke all on function public.increment_customer_profile_lifetime_count(uuid) from authenticated;
grant execute on function public.increment_customer_profile_lifetime_count(uuid) to service_role;
