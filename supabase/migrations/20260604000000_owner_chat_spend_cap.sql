-- Owner-dashboard chat spend cap ("runaway fuse").
--
-- Context: PR #104 routed the OwnerCoworker agent to Gemini 2.5 Flash-Lite for
-- sub-second-class latency (the CPU-only local model timed out on the owner's
-- long per-turn prompt). Gemini bills per token (~$0.0003/turn), so a runaway
-- loop / abusive thread could rack up cost. This adds a per-business, per
-- billing-period spend meter and a hard fuse: once a business crosses
-- OWNER_CHAT_SPEND_CAP for the period, the VPS chat-worker routes owner chat to
-- the LOCAL Qwen agent (OwnerCoworkerLocal, $0 marginal cost) instead of
-- Gemini. The worker decides this authoritatively at claim time from live
-- spend (so a burst of queued jobs still downgrades once the fuse trips, and
-- the cap lives in exactly one place). The fuse auto-resets at the next billing
-- period because spend is keyed by stripe_current_period_start — a fresh period
-- gets a fresh row at 0.
--
-- Mirrors the voice metering shape (voice_billing_period_usage): period-keyed
-- table + an atomic increment RPC. No floats: spend is stored in micro-USD
-- (1e-6 USD) integers so concurrent increments are exact. $10 = 10_000_000.

-- ---------------------------------------------------------------------------
-- Per-business, per-period spend meter.
-- ---------------------------------------------------------------------------
create table if not exists owner_chat_model_spend (
  business_id uuid not null references businesses(id) on delete cascade,
  -- Billing period this spend counts against. Sourced from
  -- subscriptions.stripe_current_period_start so the fuse resets each month.
  period_start timestamptz not null,
  -- Cumulative estimated owner-chat model spend for the period, in micro-USD
  -- (1 USD = 1_000_000). Estimated from token counts at list price; this is a
  -- safety fuse, not an invoice, so approximate is fine.
  spend_micros bigint not null default 0,
  -- Number of metered (Gemini-backed) owner-chat turns this period.
  turn_count integer not null default 0,
  -- First time the cap was crossed this period (null until tripped). Used to
  -- emit a single operator alert per period rather than one per over-cap turn.
  fuse_tripped_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (business_id, period_start)
);

alter table owner_chat_model_spend enable row level security;

drop policy if exists "Service role manages owner_chat_model_spend" on owner_chat_model_spend;
create policy "Service role manages owner_chat_model_spend"
  on owner_chat_model_spend for all
  using (auth.role() = 'service_role');

drop policy if exists "Owner reads own owner_chat_model_spend" on owner_chat_model_spend;
create policy "Owner reads own owner_chat_model_spend"
  on owner_chat_model_spend for select
  using (
    business_id in (
      select id from businesses where owner_email = auth.email()
    )
  );

comment on table owner_chat_model_spend is
  'Per-business, per-billing-period owner-dashboard chat (Gemini) spend meter + runaway fuse. Spend in micro-USD. Keyed by stripe_current_period_start so the fuse auto-resets each period.';

-- ---------------------------------------------------------------------------
-- Atomic increment + fuse RPC.
--
-- Adds p_cost_micros to the period row (upserting it if absent), increments
-- the turn counter, and — when the running total crosses p_cap_micros for the
-- first time this period — stamps fuse_tripped_at. Returns the new running
-- total and whether THIS call is the one that tripped the fuse (so the worker
-- emits exactly one operator alert per period).
-- ---------------------------------------------------------------------------
create or replace function owner_chat_record_spend(
  p_business_id uuid,
  p_period_start timestamptz,
  p_cost_micros bigint,
  p_cap_micros bigint
)
returns table (spend_micros bigint, turn_count integer, fuse_newly_tripped boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_was_tripped boolean;
  v_new_total bigint;
  v_new_count integer;
  v_now_tripped boolean;
begin
  insert into owner_chat_model_spend (business_id, period_start, spend_micros, turn_count, updated_at)
  values (p_business_id, p_period_start, greatest(p_cost_micros, 0), 1, now())
  on conflict (business_id, period_start) do update
    set spend_micros = owner_chat_model_spend.spend_micros + greatest(p_cost_micros, 0),
        turn_count = owner_chat_model_spend.turn_count + 1,
        updated_at = now()
  returning
    owner_chat_model_spend.spend_micros,
    owner_chat_model_spend.turn_count,
    (owner_chat_model_spend.fuse_tripped_at is not null)
  into v_new_total, v_new_count, v_was_tripped;

  -- Trip the fuse the first time we're at/over the cap this period.
  v_now_tripped := false;
  if not v_was_tripped and v_new_total >= p_cap_micros then
    update owner_chat_model_spend
      set fuse_tripped_at = now()
      where business_id = p_business_id and period_start = p_period_start;
    v_now_tripped := true;
  end if;

  spend_micros := v_new_total;
  turn_count := v_new_count;
  fuse_newly_tripped := v_now_tripped;
  return next;
end;
$$;

comment on function owner_chat_record_spend is
  'Atomically add owner-chat model cost (micro-USD) to the period meter, bump the turn count, and trip the fuse on first cap crossing. Returns new total + whether this call tripped the fuse.';

revoke all on function owner_chat_record_spend(uuid, timestamptz, bigint, bigint) from public;
grant execute on function owner_chat_record_spend(uuid, timestamptz, bigint, bigint) to service_role;
