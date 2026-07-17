-- Self-healing voice-budget reconciliation (delete/restore budget invariant).
--
-- Incident (New Coworker HQ, 2026-07-17): the tenant's
-- voice_billing_period_usage.committed_included_seconds read 0 while the
-- immutable settlement ledger showed a finalized 300s call — the dashboard
-- plan card dropped from "Voice 5 / 250 min" to "Voice 0 / 250 min" around
-- an owner soft-delete of the call. The delete/restore paths write only
-- voice_call_transcripts (verified — no code path subtracts committed
-- seconds), but the budget row is a mutable AGGREGATE with no defense: any
-- stray write (manual table edit, operator SQL) silently sticks forever,
-- because nothing ever recomputes it and the hourly low-balance sync
-- re-stamps updated_at, destroying the forensic trail.
--
-- Fix: committed_included_seconds is now RECONCILED from the immutable
-- ledgers on the existing 5-minute maintenance sweep. The ledger is the
-- source of truth the settle path already writes atomically:
--
--   expected = sum over finalized voice_settlements (joined to their
--              reservation, keyed to this usage row's period) of
--              least(billable_seconds, reserved_included_seconds)   -- commit_inc
--            + sum of voice_forwarded_call_meter.billable_seconds for the
--              period (forwarded/transferred human legs)
--
-- `least(billable, reserved_included)` is exactly the commit_inc the settle
-- RPC computed: with no bonus, billable == commit_inc; with bonus spill,
-- included is exhausted first so commit_inc == reserved_included_seconds.
-- Verified against every live tenant row before shipping (all healthy rows
-- reproduce exactly; the incident row reconciles 0 → 300).
--
-- Scope guard: only usage rows whose monthly window is RECENT (started
-- within 35 days) are reconciled. Older periods carry historical manual
-- adjustments (e.g. the May 2026 dead-air refunds were applied straight to
-- committed_included_seconds) that today's ledger formula must not undo —
-- Amy's April row is live proof (committed 21 vs ledger 334) — and closed
-- periods are read by nothing that gates or displays.
--
-- Operational consequence: committed_included_seconds is now DERIVED state
-- inside the active window. Goodwill credits/refunds for a current period
-- must go through voice_bonus_grants (which the reserve/settle paths and
-- the dashboard snapshot already honor), never by editing committed —
-- the reconciler will put the ledger value back within 5 minutes.
--
-- Deliberately NOT handled here: a usage row missing entirely at settle
-- time. voice_reserve_for_call bootstraps the row before any reservation
-- (and therefore any settlement) can exist, and the reconciler repairs the
-- committed value within one sweep regardless.

create or replace function voice_reconcile_period_usage_row(
  p_business_id uuid,
  p_stripe_period_start timestamptz
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actual int;
  v_expected int;
begin
  select committed_included_seconds into v_actual
  from voice_billing_period_usage
  where business_id = p_business_id and stripe_period_start = p_stripe_period_start
  for update;

  if not found then
    return 0;
  end if;

  select
    coalesce((
      select sum(least(s.billable_seconds, r.reserved_included_seconds))::int
      from voice_settlements s
      join voice_reservations r on r.call_control_id = s.call_control_id
      where r.business_id = p_business_id
        and r.stripe_period_start_key = p_stripe_period_start
        and s.finalized_at is not null
        and s.billable_seconds is not null
    ), 0)
    +
    coalesce((
      select sum(m.billable_seconds)::int
      from voice_forwarded_call_meter m
      where m.business_id = p_business_id
        and m.stripe_period_start = p_stripe_period_start
    ), 0)
  into v_expected;

  if v_expected = v_actual then
    return 0;
  end if;

  update voice_billing_period_usage
  set
    committed_included_seconds = v_expected,
    updated_at = now()
  where business_id = p_business_id and stripe_period_start = p_stripe_period_start;

  return 1;
end;
$$;

comment on function voice_reconcile_period_usage_row is
  'Recomputes one voice_billing_period_usage row''s committed_included_seconds '
  'from the immutable ledgers (finalized settlements x reservations + forwarded '
  'call meter) and repairs drift in either direction. Returns 1 when repaired.';

create or replace function voice_reconcile_recent_period_usage()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  rec record;
  n int := 0;
begin
  for rec in
    select business_id, stripe_period_start
    from voice_billing_period_usage
    -- Current monthly windows only (see header): closed historical periods
    -- are display-only and predate today's ledger semantics.
    where stripe_period_start > now() - interval '35 days'
  loop
    n := n + voice_reconcile_period_usage_row(rec.business_id, rec.stripe_period_start);
  end loop;
  return n;
end;
$$;

comment on function voice_reconcile_recent_period_usage is
  'Reconciles every recent-window voice budget row against the settlement '
  'ledger. Runs on the 5-minute maintenance sweep; returns repaired-row count.';

-- Wire into the existing 5-minute maintenance sweep. Same signature, so the
-- voice-settlement-sweep edge function needs no change — it already spreads
-- the returned jsonb into the voice_maintenance_sweep telemetry event, so a
-- non-zero budget_rows_reconciled is visible in ops telemetry immediately.
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
set search_path = pg_catalog, public
as $$
declare
  v_settlements int;
  v_sessions int;
  v_res int;
  v_sms int;
  v_nonces int;
  v_budget int;
  v_sess interval := cast(p_session_stale as interval);
  v_ua interval := cast(p_res_unanswered as interval);
  v_nows interval := cast(p_res_no_ws as interval);
  v_sms_iv interval := cast(p_sms_stale as interval);
begin
  v_settlements := voice_sweep_stale_settlements(p_settlement_min_age);
  v_sessions := voice_sweep_zombie_active_sessions(v_sess);
  v_res := voice_sweep_stale_reservations(v_ua, v_nows);
  v_sms := sms_reclaim_stale_processing_jobs(v_sms_iv);
  v_nonces := stream_url_nonces_prune_expired();
  -- AFTER stale-settlement finalize, so seconds a sweep just committed are
  -- already in the ledger the reconciler reads.
  v_budget := voice_reconcile_recent_period_usage();
  return jsonb_build_object(
    'stale_settlements_finalized', v_settlements,
    'zombie_sessions_swept', v_sessions,
    'stale_reservations_released', v_res,
    'sms_jobs_reclaimed', v_sms,
    'stream_url_nonces_pruned', v_nonces,
    'budget_rows_reconciled', v_budget
  );
end;
$$;

-- The fn_grants_lockdown event trigger revokes PUBLIC/anon/authenticated on
-- create-or-replace; re-pin the service_role grants explicitly.
grant execute on function voice_reconcile_period_usage_row(uuid, timestamptz) to service_role;
grant execute on function voice_reconcile_recent_period_usage() to service_role;
grant execute on function voice_run_maintenance_sweeps(text, text, text, text, text) to service_role;
