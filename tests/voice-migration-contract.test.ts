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

  it("voice_try_finalize_settlement: allocation path uses snapshot consumer; guard rejects partial debit", () => {
    expect(voicePlatformMigration).toMatch(/consume_voice_bonus_from_allocations/s);
    expect(voicePlatformMigration).toMatch(/perform consume_voice_bonus_seconds\(r\.business_id, commit_bon\)/s);
    expect(voicePlatformMigration).toMatch(/if v_bon_took <> commit_bon then/s);
    expect(voicePlatformMigration).not.toMatch(/commit_bon := v_bon_took/s);
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
