-- Meter forwarded / transferred call minutes against the tenant's voice pool.
--
-- Background (Jul 14 2026, Amy's 9m30s call): the AI answered, invoked
-- transfer_to_owner ~13s in, and the caller then talked to the OWNER for 9
-- minutes. Settlement bills least(telnyx end, bridge media end), so the tenant
-- was debited exactly the 60s AI leg — while the platform's Telnyx account was
-- charged carrier time for the FULL duration on BOTH legs (~19.5 leg-minutes,
-- ~$0.12). Safe-mode forwards, per-caller transfer rules, and handoff-chain
-- calls answered by a human were metered at ZERO despite identical carrier
-- cost. Policy (same as SMS, set Jul 14 2026): NOTHING is exempt from
-- metering — but post-hoc meters never refuse.
--
-- Mechanics:
--   voice_forwarded_call_meter   — one row per metered call (idempotency +
--                                  audit: what was reported, what we billed).
--   voice_meter_forwarded_call() — per-minute rounds the Telnyx-reported
--                                  duration (carrier convention, matches
--                                  voice_try_finalize_settlement) and commits
--                                  it to voice_billing_period_usage.
--                                  committed_included_seconds — the SAME pool
--                                  AI settlement debits, which the dashboard
--                                  usage card and the voice_reserve_for_call
--                                  gate already read. It NEVER refuses: the
--                                  call already happened, so at/over the cap
--                                  the commit lands as visible overage and the
--                                  reserve gate refuses the NEXT call instead.
--
-- Called from telnyx-voice-call-end at the two points every forward path
-- funnels through: the wt-leg hangup (AI transfer_to_owner, caller-rule
-- transfers, safe-mode forwards) and the handoff-chain A-leg terminal when a
-- human answered. AI settlement still bills the pre-transfer AI portion; the
-- carrier bills two legs during the transferred portion, so the sum stays
-- below actual carrier leg-time.

create table if not exists voice_forwarded_call_meter (
  call_control_id text primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  stripe_period_start timestamptz not null,
  reported_seconds integer not null,
  billable_seconds integer not null,
  -- Which forwarding path produced this (warm_transfer | handoff_chain | ...).
  context text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_voice_forwarded_call_meter_business
  on voice_forwarded_call_meter (business_id, stripe_period_start);

alter table voice_forwarded_call_meter enable row level security;

create or replace function voice_meter_forwarded_call(
  p_business_id uuid,
  p_call_control_id text,
  p_reported_seconds integer,
  p_stripe_period_start timestamptz,
  p_tier_cap_seconds integer,
  p_context text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_billable int;
  v_inserted boolean;
begin
  if p_call_control_id is null or p_call_control_id = '' then
    return jsonb_build_object('ok', false, 'reason', 'no_call_control_id');
  end if;

  -- Per-MINUTE rounding, matching voice_try_finalize_settlement and the
  -- carrier's own billing increments: a 543s human leg bills as 600s.
  if p_reported_seconds is null or p_reported_seconds <= 0 then
    v_billable := 0;
  else
    v_billable := (ceil(p_reported_seconds / 60.0))::int * 60;
  end if;

  -- Idempotency: one meter per call, no matter how many webhook deliveries or
  -- sweep retries land. The insert is the atomic claim.
  insert into voice_forwarded_call_meter
    (call_control_id, business_id, stripe_period_start, reported_seconds, billable_seconds, context)
  values
    (p_call_control_id, p_business_id, p_stripe_period_start,
     coalesce(p_reported_seconds, 0), v_billable, coalesce(p_context, ''))
  on conflict (call_control_id) do nothing;
  v_inserted := found;

  if not v_inserted then
    return jsonb_build_object('ok', true, 'duplicate', true, 'billable_seconds', 0);
  end if;

  if v_billable = 0 then
    return jsonb_build_object('ok', true, 'duplicate', false, 'billable_seconds', 0);
  end if;

  -- Same usage-row bootstrap as voice_reserve_for_call: the period row may not
  -- exist yet (e.g. the tenant's first call this month was a safe-mode forward
  -- that never reserved).
  insert into voice_billing_period_usage
    (business_id, stripe_period_start, tier_cap_seconds, committed_included_seconds)
  values (p_business_id, p_stripe_period_start, p_tier_cap_seconds, 0)
  on conflict (business_id, stripe_period_start) do nothing;

  -- Commit unconditionally — never refuse a call that already happened. Over
  -- the cap this shows as overage and voice_reserve_for_call / the safe-mode
  -- pre-check refuse the NEXT call.
  update voice_billing_period_usage
  set
    committed_included_seconds = committed_included_seconds + v_billable,
    updated_at = now()
  where business_id = p_business_id and stripe_period_start = p_stripe_period_start;

  return jsonb_build_object('ok', true, 'duplicate', false, 'billable_seconds', v_billable);
end;
$$;

comment on function voice_meter_forwarded_call is
  'Meters a forwarded/transferred call''s carrier time (per-minute rounded) '
  'against the tenant''s included voice pool. Idempotent per call_control_id; '
  'counts always, never refuses (post-hoc meter — the reserve gate refuses the '
  'next call instead).';

grant execute on function voice_meter_forwarded_call(uuid, text, integer, timestamptz, integer, text) to service_role;
