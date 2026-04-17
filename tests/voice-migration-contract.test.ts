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
