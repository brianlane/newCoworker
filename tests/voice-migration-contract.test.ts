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
    // ceil(elapsed / 60.0) * 60 — this is what the Telnyx CDR
    // `Billable time` column does, and what every PSTN carrier bills on.
    expect(perMinuteRoundingMigration).toMatch(
      /wall_cap := \(ceil\(elapsed \/ 60\.0\)\)::int \* 60/
    );
  });

  it("special-cases elapsed=0 to 0 instead of paying for an unanswered call", () => {
    // Without this guard, ceil(0/60)*60 also = 0, so the explicit guard
    // looks redundant — but it's there for clarity and so a future change
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
    // unconditional commit — a call that already happened is never refused;
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
