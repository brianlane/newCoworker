-- Anchor the auto-reload SPEND ceiling to the tenant's billing period.
--
-- `usage_pack_auto_reload_claim` reset its spend counter whenever the UTC
-- CALENDAR month string changed, while every usage allowance now refills on
-- the month-window anchored to `subscriptions.stripe_current_period_start`
-- (see the sms_window_anchored_to_billing_period migration). For any tenant
-- whose anniversary is not the 1st, and that is nearly all of them, one
-- allowance window straddled a calendar boundary and therefore contained TWO
-- spend windows:
--
--   anniversary the 28th, ceiling $100/month
--     Aug 28  allowance refills; sending is heavy, packs are bought
--     Aug 31  ceiling reached at $100, auto-reload pauses
--     Sep  1  calendar month ticks over, counter resets to $0 mid-window
--     Sep 28  allowance finally refills, having permitted $200 of charges
--
-- A ceiling labelled "$100/month" that authorizes $200 of card charges
-- inside one allowance period is not a ceiling. The counter now rolls on the
-- same date the allowance does, so the ceiling means what it says.

-- ---------------------------------------------------------------------------
-- One window definition for every meter
-- ---------------------------------------------------------------------------
-- The window start was introduced as `sms_billing_window_start` when texts
-- were the only caller. It is pure date arithmetic over the subscription
-- anchor with nothing SMS-specific in it, and it now also gates auto-reload
-- spend for voice and chat packs, so the canonical name drops the prefix.
create or replace function public.billing_usage_window_start(p_business_id uuid)
returns date
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  select public.sms_billing_window_start(p_business_id);
$function$;

comment on function public.billing_usage_window_start(uuid) is
  'Start date of the tenant''s current usage/spend window, anchored to the Stripe billing period. Canonical name; sms_billing_window_start is the original implementation and is kept because the SMS enforcement functions already call it.';

grant execute on function public.billing_usage_window_start(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Carry existing spend into the first anchored window
-- ---------------------------------------------------------------------------
-- A key mismatch resets the counters to zero, which on the changeover would
-- hand every tenant a fresh ceiling on top of what they already spent this
-- calendar month: the exact over-charging this migration exists to stop, one
-- last time. Re-key the live rows instead, so their spend carries forward.
--
-- This can over-count for one window (spend from before the window start
-- counts against it), which stops auto-reload charging SOONER. For a money
-- guardrail that is the direction to err. It self-corrects at the tenant's
-- next anniversary. Rows keyed to an older calendar month are left alone:
-- their spend is historical and SHOULD reset on the next claim.
update public.usage_pack_auto_reload_rules r
set month_key = to_char(public.billing_usage_window_start(r.business_id), 'YYYY-MM-DD')
where r.month_key = to_char(timezone('utc', now()), 'YYYY-MM');

comment on column public.usage_pack_auto_reload_rules.month_key is
  'Key of the spend window the counters below belong to: the billing-anchored window start as YYYY-MM-DD (was a YYYY-MM calendar month before the auto_reload_window_anchored_to_billing_period migration). A mismatch on claim resets month_spent_cents and month_charges.';

-- ---------------------------------------------------------------------------
-- The claim path
-- ---------------------------------------------------------------------------
-- Body is the current definition with only the window key changed.
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
  -- The tenant's billing-anchored window, not the calendar month, so the
  -- ceiling covers exactly one allowance period.
  v_month text := to_char(public.billing_usage_window_start(p_business_id), 'YYYY-MM-DD');
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

  -- Window rollover resets both counters inside the same lock.
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

grant execute on function public.usage_pack_auto_reload_claim(uuid, text, text, integer, bigint, bigint, integer, text) to service_role;
