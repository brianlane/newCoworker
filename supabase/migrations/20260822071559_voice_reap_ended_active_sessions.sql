-- Retire finished rows from voice_active_sessions, and stop one bad row from
-- wedging the zombie sweep.
--
-- The leak: voice_active_sessions was designed as an ephemeral "a media stream
-- is open right now" table, but nothing ever deleted a row that finished
-- NORMALLY. The bridge stamps `ended_at` in its WebSocket close handler and
-- walks away; the only DELETE in the whole schema lives inside
-- voice_sweep_zombie_active_sessions, which is gated on `ended_at is null` and
-- therefore only ever cleans up the ABNORMAL path (a bridge that died without
-- closing). So every completed call left a permanent row. Production carried
-- 62 of them on 2026-08-04, one per call back to 2026-05-05, all with
-- `ended_at` set and all with a finalized settlement.
--
-- Why that matters even though the redeploy safety check filters
-- `ended_at is null` and so currently reads zero: CLAUDE.md tells operators to
-- consult this table before an aiflow-render sweep, and a human reading 62
-- rows concludes calls are in flight when none are. The table also grows
-- without bound, one row per call forever.
--
-- Why the fix is a reaper and not "delete the row in the bridge": deleting on
-- WS close would race settlement. voice_try_finalize_settlement reads
-- `media_started_at` off this row to derive the billing start
-- (`coalesce(r.ws_connected_at, sess_media_start, r.answer_issued_at,
-- r.created_at)`). ws_connected_at usually wins, but when voice_bridge_attach_ws
-- failed it does not, and the next fallback (answer_issued_at) is EARLIER than
-- media start, so we would silently over-bill the customer on exactly the calls
-- that already went wrong. Stamping ended_at and reaping later keeps the
-- billing read intact and is the safe ordering.

-- ---------------------------------------------------------------------------
-- 1. The reaper: delete sessions that are finished and settled.
-- ---------------------------------------------------------------------------
create or replace function voice_reap_ended_active_sessions(
  p_retain interval default interval '1 hour',
  p_hard_retain interval default interval '24 hours'
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  n int := 0;
begin
  -- Two gates, both required:
  --
  --   p_retain (1h) is the grace period. Settlement finalizes in the same
  --   transaction as the bridge's voice_record_bridge_media_end, or within the
  --   15-minute stale-settlement sweep when only one of the two hangup signals
  --   arrived. An hour clears both with room to spare.
  --
  --   The unfinalized-settlement guard is the correctness gate: never delete a
  --   row a pending settlement still needs media_started_at from.
  --
  --   p_hard_retain (24h) is the escape hatch. A settlement that is still
  --   unfinalized a day later is stuck for its own reasons (released
  --   reservation, missing reservation row) and will never read this session
  --   again, so holding the row forever just recreates the leak we are fixing.
  delete from voice_active_sessions s
  where s.ended_at is not null
    and s.ended_at < now() - p_retain
    and (
      s.ended_at < now() - p_hard_retain
      or not exists (
        select 1
        from voice_settlements st
        where st.call_control_id = s.call_control_id
          and st.finalized_at is null
      )
    );
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function voice_reap_ended_active_sessions is
  'Deletes voice_active_sessions rows whose call ended and settled. Runs on the '
  '5-minute maintenance sweep; returns the deleted-row count.';

grant execute on function voice_reap_ended_active_sessions(interval, interval) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Harden the zombie sweep so one bad row cannot wedge it.
-- ---------------------------------------------------------------------------
-- Unchanged behaviour on the happy path. Two changes:
--
--   a) Per-row exception handling. The loop calls voice_try_finalize_settlement
--      per row, which touches reservations, grants and transcripts. A single
--      row that raises used to abort the whole function, so NOTHING got swept
--      and every later row stayed `ended_at is null` forever. That is the exact
--      shape that wedges debug/redeploy-voice-bridge.ts permanently, and it
--      fails in the "I protected you" direction: the operator sees a skip, not
--      an error. Now a failing row is logged, counted, and stepped over.
--
--   b) A hard TTL. A row that has been unended and silent for p_hard (24h by
--      default) is deleted whether or not its settlement could be written. No
--      real call runs 24 hours, and a row we cannot settle must still not be
--      able to masquerade as a live call forever.
create or replace function voice_sweep_zombie_active_sessions(
  p_stale interval default interval '15 minutes',
  p_hard interval default interval '24 hours'
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  n int := 0;
  n_failed int := 0;
  n_forced int := 0;
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
    begin
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
    exception
      when others then
        -- Swallow and continue: losing the rest of the fleet's sweep to one
        -- unsettleable call is strictly worse than skipping that call.
        n_failed := n_failed + 1;
        raise warning 'voice_sweep_zombie_active_sessions: % failed: %',
          rec.call_control_id, sqlerrm;
    end;
  end loop;

  -- Hard TTL backstop for anything the loop above could not settle, including
  -- rows that have been failing every sweep since they leaked.
  delete from voice_active_sessions
  where ended_at is null
    and last_seen_at < now() - p_hard;
  get diagnostics n_forced = row_count;

  if n_failed > 0 or n_forced > 0 then
    raise warning 'voice_sweep_zombie_active_sessions: swept=% failed=% force_deleted=%',
      n, n_failed, n_forced;
  end if;

  return n + n_forced;
end;
$$;

comment on function voice_sweep_zombie_active_sessions is
  'Settles and removes unended voice_active_sessions rows gone silent past '
  'p_stale. Per-row failures are warned and skipped; rows silent past p_hard '
  'are deleted regardless so a leak cannot wedge redeploy safety checks.';

grant execute on function voice_sweep_zombie_active_sessions(interval, interval) to service_role;

-- The one-arg signature still exists from 20260420100000 and is what
-- voice_run_maintenance_sweeps called before this migration. Drop it so there
-- is exactly one definition to reason about and no chance of a caller pinning
-- the un-hardened version.
drop function if exists voice_sweep_zombie_active_sessions(interval);

-- ---------------------------------------------------------------------------
-- 3. Wire the reaper into the 5-minute maintenance sweep.
-- ---------------------------------------------------------------------------
-- Same signature as 20260811210001, so the voice-settlement-sweep Edge function
-- needs no change: it spreads the returned jsonb into the
-- voice_maintenance_sweep telemetry event, so ended_sessions_reaped shows up in
-- ops telemetry the first time it runs.
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
  v_reaped int;
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
  -- AFTER the zombie sweep, so a row that sweep just stamped-and-settled in
  -- this same tick is eligible on the next one rather than lingering a cycle.
  v_reaped := voice_reap_ended_active_sessions();
  v_res := voice_sweep_stale_reservations(v_ua, v_nows);
  v_sms := sms_reclaim_stale_processing_jobs(v_sms_iv);
  v_nonces := stream_url_nonces_prune_expired();
  -- AFTER stale-settlement finalize, so seconds a sweep just committed are
  -- already in the ledger the reconciler reads.
  v_budget := voice_reconcile_recent_period_usage();
  return jsonb_build_object(
    'stale_settlements_finalized', v_settlements,
    'zombie_sessions_swept', v_sessions,
    'ended_sessions_reaped', v_reaped,
    'stale_reservations_released', v_res,
    'sms_jobs_reclaimed', v_sms,
    'stream_url_nonces_pruned', v_nonces,
    'budget_rows_reconciled', v_budget
  );
end;
$$;

-- The fn_grants_lockdown event trigger revokes PUBLIC/anon/authenticated on
-- create-or-replace; re-pin the service_role grants explicitly.
grant execute on function voice_run_maintenance_sweeps(text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Index the reaper's predicate.
-- ---------------------------------------------------------------------------
-- Partial index on ended rows only: that is exactly the set the reaper scans
-- every 5 minutes, and it keeps the index small since ended rows are the ones
-- being deleted.
create index if not exists idx_voice_active_sessions_ended_at
  on voice_active_sessions (ended_at)
  where ended_at is not null;
