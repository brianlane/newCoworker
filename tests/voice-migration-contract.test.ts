import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const voicePlatformMigration = readFileSync(
  join(repoRoot, "supabase/migrations/20260420100000_voice_telnyx_platform.sql"),
  "utf8"
);

const noBillZeroTurnsMigration = readFileSync(
  join(
    repoRoot,
    "supabase/migrations/20260505190000_voice_no_bill_when_zero_turns.sql"
  ),
  "utf8"
);

const perMinuteRoundingMigration = readFileSync(
  join(
    repoRoot,
    "supabase/migrations/20260505230000_voice_per_minute_rounding.sql"
  ),
  "utf8"
);

describe("voice SQL migrations (contract)", () => {
  it("voice_reserve_for_call: included headroom sums reserved_included_seconds only", () => {
    expect(voicePlatformMigration).toMatch(/coalesce\(sum\(reserved_included_seconds\), 0\)\s+into v_reserved_sum/s);
    expect(voicePlatformMigration).not.toMatch(
      /coalesce\(sum\(reserved_total_seconds\), 0\)\s+into v_reserved_sum/s
    );
  });

  it("voice_try_finalize_settlement: snapshot first, FIFO fallback, reduces billable on shortfall", () => {
    expect(voicePlatformMigration).toMatch(/consume_voice_bonus_from_allocations/s);
    expect(voicePlatformMigration).toMatch(
      /v_bon_took := consume_voice_bonus_seconds\(\s*r\.business_id,\s*commit_bon\s*\)/s
    );
    expect(voicePlatformMigration).toMatch(
      /v_bon_took := v_bon_took \+ consume_voice_bonus_seconds\(\s*r\.business_id,\s*commit_bon - v_bon_took\s*\)/s
    );
    expect(voicePlatformMigration).toMatch(
      /billable := billable - \(commit_bon - v_bon_took\);\s*commit_bon := v_bon_took;/s
    );
    expect(voicePlatformMigration).not.toMatch(/'bonus_allocation_shortfall'/);
  });

  it("voice_reserve_for_call: fills up to max grant from bonus when included partial", () => {
    expect(voicePlatformMigration).toMatch(
      /if v_from_inc < p_max_grant_seconds and v_bonus_pool > 0 then[\s\S]*?v_need := p_max_grant_seconds - v_from_inc;[\s\S]*?v_from_bon := least\(v_need, v_bonus_pool\);/s
    );
  });

  it("voice_sweep_stale_reservations: skips reservations with active WS session", () => {
    expect(voicePlatformMigration).toMatch(
      /voice_sweep_stale_reservations[\s\S]*?not exists \(\s*select 1 from voice_active_sessions s\s*where s\.call_control_id = r\.call_control_id\s*and s\.ended_at is null\s*\)/s
    );
  });

  it("voice_bridge_attach_ws: coalesces answer_issued_at and flips pending_answer -> active", () => {
    expect(voicePlatformMigration).toMatch(
      /create or replace function voice_bridge_attach_ws\(\s*p_call_control_id text,\s*p_now timestamptz/s
    );
    expect(voicePlatformMigration).toMatch(/answer_issued_at = coalesce\(answer_issued_at, p_now\)/);
    expect(voicePlatformMigration).toMatch(/when state = 'pending_answer' then 'active'/);
  });

  it("telnyx webhook: claim lease + rate check + mark_complete clears claim", () => {
    expect(voicePlatformMigration).toMatch(/claim_until/);
    expect(voicePlatformMigration).toMatch(/'status', 'busy'/);
    expect(voicePlatformMigration).toMatch(/telnyx_webhook_rate_check/);
    expect(voicePlatformMigration).toMatch(/claim_until = null/);
  });

  it("maintenance sweeps: zombies, stale reservations, SMS reclaim, nonce prune, bundled RPC", () => {
    expect(voicePlatformMigration).toMatch(/voice_sweep_zombie_active_sessions/);
    expect(voicePlatformMigration).toMatch(/voice_sweep_stale_reservations/);
    expect(voicePlatformMigration).toMatch(/sms_reclaim_stale_processing_jobs/);
    expect(voicePlatformMigration).toMatch(/stream_url_nonces_prune_expired/);
    expect(voicePlatformMigration).toMatch(/stream_url_nonces_pruned/);
    expect(voicePlatformMigration).toMatch(/voice_run_maintenance_sweeps/);
  });

  it("answer lifecycle RPCs exist (Edge telnyx-voice-inbound)", () => {
    expect(voicePlatformMigration).toMatch(
      /create or replace function voice_mark_answer_issued\(p_call_control_id text\)\s+returns jsonb/s
    );
    expect(voicePlatformMigration).toMatch(/'reason', 'not_eligible'/);
    expect(voicePlatformMigration).toMatch(
      /create or replace function voice_release_reservation_on_answer_fail\(p_call_control_id text\)\s+returns jsonb/s
    );
    expect(voicePlatformMigration).toMatch(/'released_rows', n/);
  });

  it("SMS claim sets outbound idempotency at claim time; TCR columns on telnyx settings", () => {
    expect(voicePlatformMigration).toMatch(
      /outbound_idempotency_key = coalesce\(j\.outbound_idempotency_key, gen_random_uuid\(\)\)/
    );
    expect(voicePlatformMigration).toMatch(/telnyx_tcr_campaign_id/);
  });

  it("bonus checkout + low-balance alert RPCs exist", () => {
    expect(voicePlatformMigration).toMatch(/apply_voice_bonus_grant_from_checkout/);
    expect(voicePlatformMigration).toMatch(/voice_list_low_balance_alert_targets/);
    expect(voicePlatformMigration).toMatch(/voice_mark_low_balance_alerts_sent/);
  });

  it("re-arm low balance, bonus subscription guard, zombie finalize, failover claim (same migration)", () => {
    expect(voicePlatformMigration).toMatch(/voice_sync_low_balance_alert_armed/);
    expect(voicePlatformMigration).toMatch(/no_active_subscription/);
    expect(voicePlatformMigration).toMatch(/voice_try_finalize_settlement\(rec\.call_control_id, true\)/);
    expect(voicePlatformMigration).toMatch(/voice_claim_failover_maintenance_speak/);
    expect(voicePlatformMigration).toMatch(/zombie_sessions_swept/);
  });
});

describe("voice settlement: zero-turn no-bill guard", () => {
  it("adds no_turns_zero_billed marker column to voice_settlements", () => {
    expect(noBillZeroTurnsMigration).toMatch(
      /alter table voice_settlements\s+add column if not exists no_turns_zero_billed boolean not null default false/
    );
  });

  it("counts transcript turns by call_control_id before committing seconds", () => {
    expect(noBillZeroTurnsMigration).toMatch(
      /select count\(\*\) into v_turn_count[\s\S]*?from voice_call_transcript_turns t[\s\S]*?join voice_call_transcripts vct on vct\.id = t\.transcript_id[\s\S]*?where vct\.call_control_id = p_call_control_id/s
    );
  });

  it("when v_turn_count = 0, stamps billable_seconds = 0 and skips committed_included_seconds update", () => {
    expect(noBillZeroTurnsMigration).toMatch(
      /if v_turn_count = 0 then[\s\S]*?billable_seconds = 0,[\s\S]*?no_turns_zero_billed = true/s
    );
    // The early-return must move the reservation to settled so the slot is freed.
    expect(noBillZeroTurnsMigration).toMatch(
      /if v_turn_count = 0 then[\s\S]*?update voice_reservations\s+set state = 'settled'/s
    );
    // The early-return must NOT update committed_included_seconds (i.e. the
    // `committed_included_seconds = committed_included_seconds + commit_inc`
    // statement only appears AFTER the v_turn_count = 0 branch).
    const idx0 = noBillZeroTurnsMigration.indexOf("if v_turn_count = 0 then");
    const idxCommit = noBillZeroTurnsMigration.indexOf(
      "committed_included_seconds = committed_included_seconds + commit_inc"
    );
    expect(idx0).toBeGreaterThan(0);
    expect(idxCommit).toBeGreaterThan(idx0);
  });

  it("returns no_turns_zero_billed flag in the success payload for the early-return path", () => {
    expect(noBillZeroTurnsMigration).toMatch(
      /'committed_included_seconds', 0,[\s\S]*?'committed_bonus_seconds', 0,[\s\S]*?'no_turns_zero_billed', true/s
    );
  });
});

describe("voice settlement: per-minute carrier rounding", () => {
  it("rounds wall-clock elapsed UP to the next 60-second increment", () => {
    // ceil(elapsed / 60.0) * 60, this is what the Telnyx CDR
    // `Billable time` column does, and what every PSTN carrier bills on.
    expect(perMinuteRoundingMigration).toMatch(
      /wall_cap := \(ceil\(elapsed \/ 60\.0\)\)::int \* 60/
    );
  });

  it("special-cases elapsed=0 to 0 instead of paying for an unanswered call", () => {
    // Without this guard, ceil(0/60)*60 also = 0, so the explicit guard
    // looks redundant, but it's there for clarity and so a future change
    // to the rounding kernel doesn't accidentally start charging 60s for
    // call.initiated → immediate hangup events.
    expect(perMinuteRoundingMigration).toMatch(
      /if elapsed = 0 then\s+wall_cap := 0;\s+else\s+wall_cap := \(ceil\(elapsed \/ 60\.0\)\)::int \* 60/
    );
  });

  it("rounds the carrier-reported duration UP to next 60s before capping", () => {
    // Telnyx webhook reports raw seconds; their billing rounds up. We must
    // round our cap the same way or a 33s call with carrier_raw=33 gets
    // capped to 33 (under-billing the customer relative to carrier cost).
    expect(perMinuteRoundingMigration).toMatch(
      /carrier_cap := \(ceil\(carrier_raw \/ 60\.0\)\)::int \* 60/
    );
    // And a carrier_raw of zero is preserved as zero (don't bill for
    // unanswered legs even if the post-rounding kernel would have).
    expect(perMinuteRoundingMigration).toMatch(
      /if carrier_raw = 0 then\s+carrier_cap := 0;/
    );
  });

  it("preserves the reserved_total_seconds clamp post-rounding", () => {
    // After per-minute rounding pushes wall_cap up, we still cap at the
    // reservation ceiling so we never bill more than was reserved at
    // call-start (e.g. starter plan with <60s left in the window).
    expect(perMinuteRoundingMigration).toMatch(
      /wall_cap := \(ceil\(elapsed \/ 60\.0\)\)::int \* 60;\s+end if;\s+if wall_cap > r\.reserved_total_seconds then\s+wall_cap := r\.reserved_total_seconds;\s+end if;/
    );
  });

  it("preserves the zero-turn guard on top of per-minute rounding", () => {
    // Composing the two rules: zero-turn guard takes precedence over the
    // rounded wall_cap so we never bill 60s for a silent call that
    // produced no LLM service.
    expect(perMinuteRoundingMigration).toMatch(
      /select count\(\*\) into v_turn_count[\s\S]*?from voice_call_transcript_turns/s
    );
    expect(perMinuteRoundingMigration).toMatch(
      /if v_turn_count = 0 then[\s\S]*?billable_seconds = 0,[\s\S]*?no_turns_zero_billed = true/s
    );
  });

  it("uses least(wall_cap, carrier_cap) so neither side over-bills the other", () => {
    // We always trust the smaller of "what we measured" and "what carrier
    // billed us". If carrier_raw is null (Telnyx hangup webhook hasn't
    // arrived), we fall back to wall_cap alone.
    expect(perMinuteRoundingMigration).toMatch(
      /billable := least\(wall_cap, carrier_cap\)/
    );
    expect(perMinuteRoundingMigration).toMatch(
      /else\s+billable := wall_cap;/
    );
  });
});

const forwardedMeterMigration = readFileSync(
  join(
    repoRoot,
    "supabase/migrations/20260806000100_meter_forwarded_call_minutes.sql"
  ),
  "utf8"
);

describe("voice_meter_forwarded_call migration (contract)", () => {
  it("is idempotent per call_control_id via insert-as-claim", () => {
    // One meter per leg no matter how many webhook deliveries land: the
    // insert into the meter ledger is the atomic claim, and a conflict
    // short-circuits with duplicate=true before touching period usage.
    expect(forwardedMeterMigration).toMatch(
      /insert into voice_forwarded_call_meter[\s\S]*?on conflict \(call_control_id\) do nothing;/s
    );
    expect(forwardedMeterMigration).toMatch(
      /if not v_inserted then\s+return jsonb_build_object\('ok', true, 'duplicate', true/s
    );
  });

  it("per-minute rounds like voice_try_finalize_settlement", () => {
    expect(forwardedMeterMigration).toMatch(
      /v_billable := \(ceil\(p_reported_seconds \/ 60\.0\)\)::int \* 60;/
    );
    // Zero / missing duration bills nothing (carrier doesn't charge
    // unanswered legs).
    expect(forwardedMeterMigration).toMatch(
      /if p_reported_seconds is null or p_reported_seconds <= 0 then\s+v_billable := 0;/s
    );
  });

  it("commits to the same pool the reserve gate reads, unconditionally (never refuses)", () => {
    // Same usage-row bootstrap as voice_reserve_for_call, then an
    // unconditional commit, a call that already happened is never refused;
    // over the cap it lands as visible overage and the NEXT call is refused
    // by the reserve gate / safe-mode pre-check instead.
    expect(forwardedMeterMigration).toMatch(
      /insert into voice_billing_period_usage[\s\S]*?on conflict \(business_id, stripe_period_start\) do nothing;/s
    );
    expect(forwardedMeterMigration).toMatch(
      /committed_included_seconds = committed_included_seconds \+ v_billable/
    );
    // No refusal branch: the only non-ok return is a missing call id.
    expect(forwardedMeterMigration).not.toMatch(/quota_exhausted|refused/);
  });
});

const reapEndedSessionsMigration = readFileSync(
  join(
    repoRoot,
    "supabase/migrations/20260822071559_voice_reap_ended_active_sessions.sql"
  ),
  "utf8"
);

describe("voice_active_sessions: ended-row reaper and un-wedgeable zombie sweep", () => {
  it("reaper deletes only ended rows, past the grace period", () => {
    // The whole point: before this migration NOTHING deleted a row whose
    // call finished normally, because the only DELETE was gated on
    // `ended_at is null`. The reaper is the missing half.
    expect(reapEndedSessionsMigration).toMatch(
      /create or replace function voice_reap_ended_active_sessions\(\s*p_retain interval default interval '1 hour',\s*p_hard_retain interval default interval '24 hours'/s
    );
    expect(reapEndedSessionsMigration).toMatch(
      /delete from voice_active_sessions s\s+where s\.ended_at is not null\s+and s\.ended_at < now\(\) - p_retain/s
    );
  });

  it("reaper never deletes a session an unfinalized settlement still needs", () => {
    // voice_try_finalize_settlement reads media_started_at off this row to
    // derive the billing start. Deleting early would silently fall back to
    // an EARLIER timestamp and over-bill the customer.
    expect(reapEndedSessionsMigration).toMatch(
      /not exists \(\s*select 1\s+from voice_settlements st\s+where st\.call_control_id = s\.call_control_id\s+and st\.finalized_at is null\s*\)/s
    );
    // ...unless the row is past the hard ceiling, or a permanently stuck
    // settlement would recreate the leak this migration exists to fix.
    expect(reapEndedSessionsMigration).toMatch(/s\.ended_at < now\(\) - p_hard_retain\s*\n\s*or not exists/s);
  });

  it("zombie sweep contains per-row failures instead of aborting the whole loop", () => {
    // One unsettleable call used to abort the function, so nothing was swept
    // and every later row stayed `ended_at is null` forever, the exact shape
    // that wedges the redeploy safety check into skipping a tenant with no
    // error to look at.
    expect(reapEndedSessionsMigration).toMatch(
      /j := voice_try_finalize_settlement\(rec\.call_control_id, true\);[\s\S]*?exception\s+when others then/s
    );
    expect(reapEndedSessionsMigration).toMatch(/n_failed := n_failed \+ 1/);
  });

  it("zombie sweep hard-deletes rows silent past the ceiling, settled or not", () => {
    expect(reapEndedSessionsMigration).toMatch(
      /create or replace function voice_sweep_zombie_active_sessions\(\s*p_stale interval default interval '15 minutes',\s*p_hard interval default interval '24 hours'/s
    );
    expect(reapEndedSessionsMigration).toMatch(
      /delete from voice_active_sessions\s+where ended_at is null\s+and last_seen_at < now\(\) - p_hard/s
    );
    // The superseded one-arg signature must go, or a one-arg call is
    // ambiguous between the two overloads and errors at runtime.
    expect(reapEndedSessionsMigration).toMatch(
      /drop function if exists voice_sweep_zombie_active_sessions\(interval\)/
    );
  });

  it("drops the old overload BEFORE anything names the function without arguments", () => {
    // While both overloads exist, every statement that names
    // voice_sweep_zombie_active_sessions with no argument list fails with
    // "function name is not unique" (SQLSTATE 42725). That is not theoretical:
    // it broke the Worker Integration job on this PR's first push, on the
    // COMMENT statement. So the DROP must come first, and the COMMENT must
    // carry an explicit signature anyway.
    const dropAt = reapEndedSessionsMigration.indexOf(
      "drop function if exists voice_sweep_zombie_active_sessions(interval)"
    );
    const commentAt = reapEndedSessionsMigration.indexOf(
      "comment on function voice_sweep_zombie_active_sessions"
    );
    const oneArgCallAt = reapEndedSessionsMigration.indexOf(
      "voice_sweep_zombie_active_sessions(v_sess)"
    );
    expect(dropAt).toBeGreaterThan(0);
    expect(commentAt).toBeGreaterThan(dropAt);
    expect(oneArgCallAt).toBeGreaterThan(dropAt);

    // Every COMMENT in this file carries its signature, so a future overload
    // cannot reintroduce the same ambiguity.
    for (const match of reapEndedSessionsMigration.matchAll(/comment on function ([^\s]+)/g)) {
      expect(match[1], `comment on function ${match[1]} needs an explicit argument list`).toContain(
        "("
      );
    }
  });

  it("reaper runs on the 5-minute maintenance sweep and reports its count", () => {
    expect(reapEndedSessionsMigration).toMatch(
      /v_reaped := voice_reap_ended_active_sessions\(\)/
    );
    expect(reapEndedSessionsMigration).toMatch(/'ended_sessions_reaped', v_reaped/);
    // Signature unchanged, so the voice-settlement-sweep Edge function keeps
    // working untouched.
    expect(reapEndedSessionsMigration).toMatch(
      /create or replace function voice_run_maintenance_sweeps\(\s*p_settlement_min_age text default '15 minutes',\s*p_session_stale text default '15 minutes',\s*p_res_unanswered text default '3 minutes',\s*p_res_no_ws text default '10 minutes',\s*p_sms_stale text default '15 minutes'\s*\)/s
    );
  });

  it("re-pins service_role grants on every replaced function", () => {
    // fn_grants_lockdown strips grants on create-or-replace.
    expect(reapEndedSessionsMigration).toMatch(
      /grant execute on function voice_reap_ended_active_sessions\(interval, interval\) to service_role/
    );
    expect(reapEndedSessionsMigration).toMatch(
      /grant execute on function voice_sweep_zombie_active_sessions\(interval, interval\) to service_role/
    );
    expect(reapEndedSessionsMigration).toMatch(
      /grant execute on function voice_run_maintenance_sweeps\(text, text, text, text, text\) to service_role/
    );
  });
});

/**
 * voice_capacity_alerts (Telnyx capacity admin alerts): the claim must be
 * atomic FLEET-WIDE and reachable by the service role, or the alert path
 * silently dies with "permission denied" in production (the Data API grants
 * convention: nothing in public is granted by default anymore).
 */
describe("voice_capacity_alerts migration (contract)", () => {
  const migration = readFileSync(
    join(repoRoot, "supabase/migrations/20260822135958_voice_capacity_alerts.sql"),
    "utf8"
  );

  it("claims through a fleet-wide unique bucket (insert-or-nothing)", () => {
    expect(migration).toMatch(
      /create unique index if not exists uq_voice_capacity_alerts_bucket\s+on voice_capacity_alerts \(alert_bucket\)/s
    );
    expect(migration).toMatch(/on conflict \(alert_bucket\) do nothing/s);
    // Fleet-wide on purpose: the carrier channel pool is shared, so the
    // bucket key must NOT include business_id (that would email once per
    // starved tenant instead of once per incident window).
    expect(migration).not.toMatch(/on conflict \(business_id, alert_bucket\)/s);
  });

  it("hardens and grants the claim function for PostgREST", () => {
    expect(migration).toMatch(/security definer/);
    expect(migration).toMatch(/set search_path = pg_catalog, public/);
    expect(migration).toMatch(
      /revoke all on function voice_capacity_try_claim_alert\(uuid, uuid, text, int, int\) from public/
    );
    expect(migration).toMatch(
      /grant execute on function voice_capacity_try_claim_alert\(uuid, uuid, text, int, int\) to service_role/
    );
  });

  it("locks the table to the service role (RLS on, explicit table grants)", () => {
    expect(migration).toMatch(/alter table voice_capacity_alerts enable row level security/);
    expect(migration).toMatch(
      /grant select, insert, delete on table voice_capacity_alerts to service_role/
    );
  });

  it("refuses a non-positive bucket length instead of dividing by zero", () => {
    expect(migration).toMatch(/if p_bucket_minutes is null or p_bucket_minutes < 1 then\s+return null/s);
  });
});

/**
 * voice_outbound_platform_gate (the fleet-wide outbound gate): the overload
 * hazard is the sharp edge. Adding a parameter via `create or replace`
 * leaves the old 5-arg signature alive as an OVERLOAD, and PostgREST's
 * named-argument dispatch refuses ambiguous overloads at runtime, killing
 * every pre-dial probe. The DROP must ship in the same file, first.
 */
describe("voice_outbound_platform_gate migration (contract)", () => {
  const migration = readFileSync(
    join(repoRoot, "supabase/migrations/20260822142534_voice_outbound_platform_gate.sql"),
    "utf8"
  );

  it("drops the old 5-arg signature before recreating with the platform param", () => {
    const dropAt = migration.indexOf(
      "drop function if exists public.voice_check_availability(uuid, integer, timestamptz, integer, integer);"
    );
    const createAt = migration.indexOf("create or replace function voice_check_availability(");
    expect(dropAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(dropAt);
    expect(migration).toMatch(/p_platform_max_outbound integer default null/);
  });

  it("checks the FLEET outbound count before any per-business math, and only when set", () => {
    expect(migration).toMatch(
      /if p_platform_max_outbound is not null and p_platform_max_outbound > 0 then[\s\S]*?where direction = 'outbound' and state in \('pending_answer', 'active'\)/
    );
    const fleetAt = migration.indexOf("'platform_capacity'");
    const perBizAt = migration.indexOf("'concurrent_limit'");
    expect(fleetAt).toBeGreaterThan(-1);
    expect(fleetAt).toBeLessThan(perBizAt);
    // Deliberately unfiltered by business_id: the Telnyx pool is shared.
    expect(migration).not.toMatch(
      /where business_id = p_business_id and direction = 'outbound'/
    );
  });

  it("adds the direction column with its check and default, plus the gate index", () => {
    expect(migration).toMatch(
      /add column if not exists direction text not null default 'inbound'\s+check \(direction in \('inbound', 'outbound'\)\)/
    );
    expect(migration).toMatch(
      /create index if not exists idx_voice_reservations_direction_state\s+on voice_reservations \(direction, state\)/
    );
  });

  it("re-grants execute on the NEW 6-arg signature", () => {
    expect(migration).toMatch(
      /grant execute on function voice_check_availability\(uuid, integer, timestamptz, integer, integer, integer\)\s+to service_role/
    );
  });

  it("leaves voice_reserve_for_call untouched (pre-dial fail-fast only)", () => {
    expect(migration).not.toMatch(/voice_reserve_for_call\s*\(/);
  });
});

/**
 * voice_capacity_monitor migration: splits the alert dedupe by kind and
 * re-signs the claim RPC. Same overload hazard as the availability probe:
 * the old 5-arg claim must be dropped before the 6-arg recreate.
 */
describe("voice_capacity_monitor migration (contract)", () => {
  const migration = readFileSync(
    join(repoRoot, "supabase/migrations/20260822144118_voice_capacity_monitor.sql"),
    "utf8"
  );

  it("adds the kind column and replaces the fleet-wide unique with (kind, bucket)", () => {
    expect(migration).toMatch(
      /add column if not exists kind text not null default 'carrier_rejection'\s+check \(kind in \('carrier_rejection', 'capacity_monitor'\)\)/
    );
    expect(migration).toMatch(/drop index if exists uq_voice_capacity_alerts_bucket/);
    expect(migration).toMatch(
      /create unique index if not exists uq_voice_capacity_alerts_kind_bucket\s+on voice_capacity_alerts \(kind, alert_bucket\)/
    );
    expect(migration).toMatch(/on conflict \(kind, alert_bucket\) do nothing/);
  });

  it("drops the 5-arg claim before recreating with p_kind, and re-grants the 6-arg", () => {
    const dropAt = migration.indexOf(
      "drop function if exists public.voice_capacity_try_claim_alert(uuid, uuid, text, int, int);"
    );
    const createAt = migration.indexOf(
      "create or replace function voice_capacity_try_claim_alert("
    );
    expect(dropAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(dropAt);
    expect(migration).toMatch(/p_kind text default 'carrier_rejection'/);
    expect(migration).toMatch(
      /grant execute on function voice_capacity_try_claim_alert\(uuid, uuid, text, int, int, text\) to service_role/
    );
  });

  it("schedules the weekly cron through the vault-read pattern", () => {
    expect(migration).toMatch(/cron\.schedule\(\s*'edge-voice-capacity-monitor',\s*'0 15 \* \* 1'/);
    expect(migration).toMatch(/voice-capacity-monitor/);
    expect(migration).toMatch(/timeout_milliseconds := 60000/);
  });
});

/** voice_outbound_dial_headroom: the per-tenant transfer/reach reserve. */
describe("voice_outbound_dial_headroom migration (contract)", () => {
  const migration = readFileSync(
    join(repoRoot, "supabase/migrations/20260822150816_voice_outbound_dial_headroom.sql"),
    "utf8"
  );

  it("adds a bounded nullable column (0..9 so one dial slot always survives)", () => {
    expect(migration).toMatch(
      /add column if not exists voice_outbound_dial_headroom integer/
    );
    expect(migration).toMatch(/voice_outbound_dial_headroom >= 0/);
    expect(migration).toMatch(/voice_outbound_dial_headroom <= 9/);
    expect(migration).toMatch(/is null\s+or/);
  });
});
