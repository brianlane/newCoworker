-- Auto-reload fast path: react in about a minute instead of up to fifteen.
--
-- The sweep runs every 15 minutes and rescans every armed rule. That is the
-- weakest part of the design: a single ten minute voice call can take a
-- tenant from comfortably above their threshold to zero, and the top-up then
-- lands up to fifteen minutes later, after calls have already been refused.
--
-- Dropping the interval is the wrong fix. A full rescan computes real balances
-- for every armed rule, so running it every minute multiplies that cost by
-- fifteen for a signal that is almost always "nothing changed".
--
-- Instead: consumption stamps `needs_check_at` on the affected rule, and a
-- second job runs every minute over ONLY the stamped rules. The stamped set is
-- normally empty or tiny, so the frequent job is cheap. The 15 minute full
-- scan stays exactly as it is, as the backstop for anything the stamps miss.
--
-- Why triggers rather than editing the consume functions:
--   `try_reserve_sms_outbound_slot` and `voice_try_finalize_settlement` are
--   long, hot, and already carry a documented drift hazard (each has been
--   re-declared by later migrations, and the bodies must stay in step). Adding
--   a call inside them would mean re-declaring both again. A trigger on the
--   tables they write gets the same signal, cannot drift out of step with a
--   function body, and catches any future writer for free.
--
-- The stamp is a HINT, never a decision. It says "this tenant consumed
-- something", not "this tenant is below threshold". All real balance math
-- stays in TypeScript, where the tier caps and env-derived ceilings live.

alter table public.usage_pack_auto_reload_rules
  add column if not exists needs_check_at timestamptz;

comment on column public.usage_pack_auto_reload_rules.needs_check_at is
  'Set by consumption triggers, cleared when the fast sweep picks the rule up. A hint that this tenant used something, not a claim that they are below threshold.';

-- The fast sweep''s whole query. Partial, so it indexes only the rules that
-- currently need looking at, which is normally near zero rows.
create index if not exists idx_usage_pack_auto_reload_rules_needs_check
  on public.usage_pack_auto_reload_rules (needs_check_at)
  where needs_check_at is not null;

-- ---------------------------------------------------------------------------
-- The stamp
-- ---------------------------------------------------------------------------
-- Deliberately cheap: a primary-key UPDATE that matches ZERO rows for every
-- tenant without an armed rule for that family, which is the overwhelming
-- majority. It never blocks the caller's own work and never raises.
create or replace function public.usage_pack_auto_reload_mark_needs_check(
  p_business_id uuid,
  p_category text
)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.usage_pack_auto_reload_rules
  set needs_check_at = now()
  where business_id = p_business_id
    and category = p_category
    and enabled
    and paused_at is null
    -- Already stamped: leave the earlier timestamp so the queue stays FIFO.
    and needs_check_at is null;
$$;

revoke execute on function public.usage_pack_auto_reload_mark_needs_check(uuid, text) from public;
grant execute on function public.usage_pack_auto_reload_mark_needs_check(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Triggers on the tables consumption actually writes
-- ---------------------------------------------------------------------------
-- grants: none (usage_pack_auto_reload_stamp_sms): trigger function, runs as owner
create or replace function public.usage_pack_auto_reload_stamp_sms()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.usage_pack_auto_reload_mark_needs_check(new.business_id, 'sms');
  return null;
end;
$$;

-- grants: none (usage_pack_auto_reload_stamp_voice): trigger function, runs as owner
create or replace function public.usage_pack_auto_reload_stamp_voice()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.usage_pack_auto_reload_mark_needs_check(new.business_id, 'voice');
  return null;
end;
$$;

-- grants: none (usage_pack_auto_reload_stamp_chat): trigger function, runs as owner
create or replace function public.usage_pack_auto_reload_stamp_chat()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.usage_pack_auto_reload_mark_needs_check(new.business_id, 'chat');
  return null;
end;
$$;

-- AFTER triggers, so a stamp can never fail or slow the send/call/turn that
-- produced it. All are FOR EACH ROW because the business id lives on the row.

-- Plan texts: daily_usage.sms_sent is incremented by every outbound reserve.
drop trigger if exists trg_auto_reload_stamp_sms_usage on public.daily_usage;
create trigger trg_auto_reload_stamp_sms_usage
  after insert or update of sms_sent on public.daily_usage
  for each row execute function public.usage_pack_auto_reload_stamp_sms();

-- Purchased texts: decremented when a send spills past the plan cap.
drop trigger if exists trg_auto_reload_stamp_sms_bonus on public.sms_bonus_grants;
create trigger trg_auto_reload_stamp_sms_bonus
  after update of texts_remaining on public.sms_bonus_grants
  for each row execute function public.usage_pack_auto_reload_stamp_sms();

-- Included voice: committed at settlement. This is the case that motivated
-- the whole change, because one long call can cross the threshold alone.
drop trigger if exists trg_auto_reload_stamp_voice_usage on public.voice_billing_period_usage;
create trigger trg_auto_reload_stamp_voice_usage
  after update of committed_included_seconds on public.voice_billing_period_usage
  for each row execute function public.usage_pack_auto_reload_stamp_voice();

-- Purchased voice seconds.
drop trigger if exists trg_auto_reload_stamp_voice_bonus on public.voice_bonus_grants;
create trigger trg_auto_reload_stamp_voice_bonus
  after update of seconds_remaining on public.voice_bonus_grants
  for each row execute function public.usage_pack_auto_reload_stamp_voice();

-- Chat spend. Least urgent of the three (running out degrades to a slower
-- model rather than refusing work), but the signal is the same shape.
drop trigger if exists trg_auto_reload_stamp_chat on public.owner_chat_model_spend;
create trigger trg_auto_reload_stamp_chat
  after insert or update of spend_micros on public.owner_chat_model_spend
  for each row execute function public.usage_pack_auto_reload_stamp_chat();

-- ---------------------------------------------------------------------------
-- Flagged candidates: same shape as the full scan, but only stamped rules
-- ---------------------------------------------------------------------------
-- Clears the stamp as it hands the rows out, so this behaves like a queue and
-- two concurrent fast ticks cannot both work the same rule. Losing a stamp to
-- a failed evaluation is acceptable: the 15 minute full scan is the backstop.
create or replace function public.usage_pack_auto_reload_flagged_candidates(
  p_limit integer default 200
)
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
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  with claimed as (
    update public.usage_pack_auto_reload_rules r
    set needs_check_at = null
    where (r.business_id, r.category) in (
      select r2.business_id, r2.category
      from public.usage_pack_auto_reload_rules r2
      where r2.needs_check_at is not null
      order by r2.needs_check_at asc
      limit greatest(1, coalesce(p_limit, 200))
      for update skip locked
    )
    returning r.business_id, r.category, r.pack_id, r.threshold_units,
              r.monthly_limit_cents, r.cooldown_minutes, r.enabled, r.paused_at,
              r.last_attempt_at, r.in_flight_at
  )
  select
    c.business_id,
    c.category,
    c.pack_id,
    c.threshold_units,
    c.monthly_limit_cents,
    c.cooldown_minutes,
    b.owner_email,
    b.name,
    b.tier,
    b.enterprise_limits,
    b.phone,
    b.timezone,
    s.stripe_customer_id,
    s.stripe_subscription_id,
    s.stripe_current_period_start,
    cd.stripe_payment_method_id
  from claimed c
  join public.businesses b on b.id = c.business_id
  join public.subscriptions s on s.business_id = c.business_id
  join public.usage_pack_auto_reload_cards cd on cd.business_id = c.business_id
  where c.enabled
    and c.paused_at is null
    and cd.revoked_at is null
    and s.status = 'active'
    and s.stripe_subscription_id is not null
    -- Same cooldown and in-flight guards as the full scan. The fast path must
    -- not become a way around them.
    and (
      c.last_attempt_at is null
      or c.last_attempt_at < now() - make_interval(mins => c.cooldown_minutes)
    )
    and (c.in_flight_at is null or c.in_flight_at < now() - interval '15 minutes');
end;
$$;

revoke execute on function public.usage_pack_auto_reload_flagged_candidates(integer) from public;
grant execute on function public.usage_pack_auto_reload_flagged_candidates(integer) to service_role;

-- ---------------------------------------------------------------------------
-- The every-minute job
-- ---------------------------------------------------------------------------
-- grants: none (edge-usage-pack-auto-reload-fast): pg_cron runs it as owner

do $unschedule$
begin
  perform cron.unschedule('edge-usage-pack-auto-reload-fast')
  where exists (
    select 1 from cron.job where jobname = 'edge-usage-pack-auto-reload-fast'
  );
end
$unschedule$;

select cron.schedule(
  'edge-usage-pack-auto-reload-fast',
  '* * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url')
      || '/functions/v1/usage-pack-auto-reload-sweep?mode=flagged',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{"mode":"flagged"}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);
