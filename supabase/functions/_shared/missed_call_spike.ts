/**
 * Missed-call spike alert (Standard/Enterprise perk, tier relaunch).
 *
 * Every inbound call telnyx-voice-inbound refuses (concurrency limit or
 * voice minutes exhausted) already writes a `voice_call_blocked` row to
 * `system_logs` — the same ledger the dashboard's answer-rate card reads.
 * This helper turns that silent ledger into a signal: the first time a
 * tenant's refused-call count crosses the threshold on a given UTC day, the
 * owner gets ONE urgent notification (SMS/email/dashboard per their
 * notification preferences) telling them callers are being turned away.
 *
 * Why this matters: a Starter tenant with 1 concurrent call slot who gets a
 * burst of calls loses customers without any visible failure — no error, no
 * log the owner reads, just callers hearing "the line is busy". The alert
 * is the difference between "silent churn" and "owner upgrades concurrency
 * or buys minutes the same day".
 *
 * Delivery + dedup ride the existing cap-alert rails:
 *   - `sendCapAlertOnce` (kind "missed_call_spike", period key = UTC date)
 *     gives atomic once-per-day dedup via `mark_usage_cap_alert`, with
 *     rollback when the notifications POST fails so a later refusal retries.
 *   - the `notifications` Edge function fans out to the owner's channels.
 *
 * Tier-gated to Standard/Enterprise (checked here, at alert time — the
 * refusal ledger itself is written for every tier).
 *
 * Never throws: alerting must never break the call-refusal path that
 * invokes it. Dependency-injected so it is unit-tested from vitest under
 * the shared 100% coverage gate.
 */

import { sendCapAlertOnce } from "./cap_alerts.ts";

/** Refused calls on one UTC day before the owner gets the alert. */
export const MISSED_CALL_SPIKE_THRESHOLD = 3;

/** Tiers entitled to the spike alert. */
export const MISSED_CALL_SPIKE_TIERS = ["standard", "enterprise"];

type MaybeSingleResult = { data: unknown; error: { message: string } | null };
type CountResult = { count: number | null; error: { message: string } | null };

export interface MissedCallSpikeSupabase {
  // PromiseLike (not Promise) so supabase-js's thenable builders satisfy the
  // interface structurally (same approach as _shared/cap_alerts.ts).
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    select(
      columns: string,
      opts?: { count?: "exact"; head?: boolean }
    ): {
      eq(
        column: string,
        value: string
      ): {
        maybeSingle(): PromiseLike<MaybeSingleResult>;
        eq(
          column: string,
          value: string
        ): {
          gte(column: string, value: string): PromiseLike<CountResult>;
        };
      };
    };
  };
}

export type MissedCallSpikeOutcome =
  | { status: "sent"; count: number }
  | {
      status: "skipped";
      reason:
        | "tier"
        | "below_threshold"
        | "already_alerted"
        | "alert_failed"
        | "lookup_failed";
      count?: number;
    };

export async function maybeSendMissedCallSpikeAlert(
  supabase: MissedCallSpikeSupabase,
  opts: {
    businessId: string;
    /** `${SUPABASE_URL}/functions/v1/notifications` */
    notifyUrl: string;
    /** Service-role key (the notifications function's expected bearer). */
    bearer: string;
    threshold?: number;
    now?: Date;
    fetchFn?: typeof fetch;
  }
): Promise<MissedCallSpikeOutcome> {
  try {
    const threshold = opts.threshold ?? MISSED_CALL_SPIKE_THRESHOLD;
    const now = opts.now ?? new Date();
    const dayKey = now.toISOString().slice(0, 10);

    // Tier gate first — no point counting for Starter tenants.
    const { data: bizData, error: bizErr } = await supabase
      .from("businesses")
      .select("tier")
      .eq("id", opts.businessId)
      .maybeSingle();
    if (bizErr) {
      console.error("missed_call_spike tier lookup", bizErr.message);
      return { status: "skipped", reason: "lookup_failed" };
    }
    const tier = (bizData as { tier?: string } | null)?.tier ?? "";
    if (!MISSED_CALL_SPIKE_TIERS.includes(tier)) {
      return { status: "skipped", reason: "tier" };
    }

    const { count, error: countErr } = await supabase
      .from("system_logs")
      .select("id", { count: "exact", head: true })
      .eq("business_id", opts.businessId)
      .eq("event", "voice_call_blocked")
      .gte("created_at", `${dayKey}T00:00:00Z`);
    if (countErr) {
      console.error("missed_call_spike count", countErr.message);
      return { status: "skipped", reason: "lookup_failed" };
    }
    const blockedToday = count ?? 0;
    if (blockedToday < threshold) {
      return { status: "skipped", reason: "below_threshold", count: blockedToday };
    }

    const result = await sendCapAlertOnce(supabase, {
      businessId: opts.businessId,
      kind: "missed_call_spike",
      periodKey: dayKey,
      notifyUrl: opts.notifyUrl,
      bearer: opts.bearer,
      payload: { missed_calls_today: blockedToday },
      fetchFn: opts.fetchFn
    });
    if (result === "sent") return { status: "sent", count: blockedToday };
    if (result === "already_alerted") {
      return { status: "skipped", reason: "already_alerted", count: blockedToday };
    }
    return { status: "skipped", reason: "alert_failed", count: blockedToday };
  } catch (err) {
    console.error(
      "missed_call_spike unexpected",
      err instanceof Error ? err.message : String(err)
    );
    return { status: "skipped", reason: "lookup_failed" };
  }
}
