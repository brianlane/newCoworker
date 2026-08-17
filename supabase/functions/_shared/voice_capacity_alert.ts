/**
 * Platform-admin alert for Telnyx outbound-capacity rejections.
 *
 * Fired inline from telnyx-voice-originate when a dial is rejected for
 * concurrent-channel capacity (classifyTelnyxDialFailure). Before this
 * existed the only artifact was a telemetry row nothing reads, and the
 * 2026-08-16 incident surfaced via an email from Telnyx instead of from our
 * own system.
 *
 * Dedupe: claim-before-send on voice_capacity_alerts through the
 * voice_capacity_try_claim_alert RPC (fleet-wide 60-minute bucket, unique
 * index makes the claim atomic), delete-to-release on any failure so the
 * next rejection retries the email. Same pattern as
 * chat-spend-velocity-alerts; fleet-wide rather than per-business because
 * the carrier channel pool is shared.
 *
 * Dependency-injected (caller passes the supabase client + fetch + env
 * reader) so this is unit-tested from vitest without Deno, mirroring
 * cap_alerts.ts. Never throws: alerting must never fail the dial path that
 * invokes it.
 */

type DbResult = { data: unknown; error: { message: string } | null };

export interface CapacityAlertSupabase {
  // PromiseLike (not Promise) so supabase-js's thenable PostgrestFilterBuilder
  // satisfies the interface structurally (same approach as cap_alerts.ts).
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<DbResult>;
  from(table: string): {
    delete(): {
      eq(column: string, value: unknown): PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

/** One email per fleet-wide bucket of this length. */
export const CAPACITY_ALERT_BUCKET_MINUTES = 60;

export type CapacityAlertInfo = {
  /** Null for fleet-level alerts (the weekly monitor). */
  businessId: string | null;
  flowId: string | null;
  toE164: string;
  httpStatus: number;
  telnyxCode: string | null;
  telnyxTitle: string | null;
  connectionId: string | null;
};

export type CapacityAlertResult =
  | "sent"
  | "already_alerted"
  | "claim_failed"
  | "unconfigured"
  | "post_failed";

/** Plain-text admin email for a capacity rejection. Exported for tests. */
export function formatCapacityAlertEmail(info: CapacityAlertInfo): {
  subject: string;
  text: string;
} {
  const lines = [
    "An outbound call was rejected by Telnyx for concurrent-channel capacity.",
    "",
    `business_id: ${info.businessId ?? "(fleet)"}`,
    `flow_id: ${info.flowId ?? "(none)"}`,
    `callee: ${info.toE164}`,
    `http_status: ${info.httpStatus}`,
    `telnyx_code: ${info.telnyxCode ?? "(unparsed)"}`,
    `telnyx_title: ${info.telnyxTitle ?? "(unparsed)"}`,
    `connection_id: ${info.connectionId ?? "(unknown)"}`,
    "",
    "The AI coworker defers and retries these dials automatically, so the",
    "call is delayed rather than lost. Repeated alerts mean the fleet is",
    "dialing into its concurrent-channel ceiling: check the three Telnyx",
    "limits (connection channel_limit, outbound voice profile",
    "concurrent_call_limit, account-level pool) and raise the binding one.",
    "This alert sends at most once per hour."
  ];
  return {
    subject: "Telnyx capacity: outbound call rejected (channel limit)",
    text: lines.join("\n")
  };
}

/**
 * Alert-stream overrides: the weekly capacity monitor rides the same
 * claim/release dedupe with its own kind, bucket length, and email body.
 * Omitted = the inline carrier-rejection alert exactly as before.
 */
export type CapacityAlertOverrides = {
  kind?: "carrier_rejection" | "capacity_monitor";
  bucketMinutes?: number;
  email?: { subject: string; text: string };
};

/**
 * Send the admin capacity alert if this fleet-wide bucket has not alerted
 * yet. Never throws; returns what happened for the caller's telemetry.
 */
export async function sendVoiceCapacityAlertOnce(
  supabase: CapacityAlertSupabase,
  info: CapacityAlertInfo,
  env: (name: string) => string | undefined,
  fetchFn: typeof fetch = fetch,
  overrides: CapacityAlertOverrides = {}
): Promise<CapacityAlertResult> {
  let claimId: unknown;
  try {
    const { data, error } = await supabase.rpc("voice_capacity_try_claim_alert", {
      p_business_id: info.businessId,
      p_flow_id: info.flowId,
      p_telnyx_code: info.telnyxCode,
      p_http_status: info.httpStatus,
      p_bucket_minutes: overrides.bucketMinutes ?? CAPACITY_ALERT_BUCKET_MINUTES,
      p_kind: overrides.kind ?? "carrier_rejection"
    });
    if (error) {
      console.error("voice-capacity-alert: claim failed", error.message);
      return "claim_failed";
    }
    claimId = data;
  } catch (err) {
    console.error("voice-capacity-alert: claim threw", err);
    return "claim_failed";
  }
  if (claimId === null || claimId === undefined) return "already_alerted";

  const release = async (): Promise<void> => {
    try {
      const { error } = await supabase.from("voice_capacity_alerts").delete().eq("id", claimId);
      if (error) console.error("voice-capacity-alert: claim release failed", error.message);
    } catch (err) {
      console.error("voice-capacity-alert: claim release threw", err);
    }
  };

  // EVERYTHING between claim and confirmed send stays inside this try: a
  // thrown fetch must release the claim, or the dedupe row silently swallows
  // alerts for the rest of the bucket (same hazard Bugbot flagged on the
  // spend-velocity alerts, PR #504).
  try {
    const resendKey = (env("RESEND_API_KEY") ?? "").trim();
    const adminTo = (
      env("ADMIN_ALERT_EMAIL") ??
      env("ADMIN_EMAIL") ??
      env("CONTACT_EMAIL") ??
      ""
    ).trim();
    const from = env("MAILER_EMAIL") ?? "New Coworker <contact@newcoworker.com>";
    if (!adminTo || !resendKey) {
      console.warn(
        "voice-capacity-alert: unconfigured (ADMIN_ALERT_EMAIL / RESEND_API_KEY missing)"
      );
      await release();
      return "unconfigured";
    }
    const email = overrides.email ?? formatCapacityAlertEmail(info);
    const res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from, to: [adminTo], subject: email.subject, text: email.text })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("voice-capacity-alert: resend failed", res.status, body.slice(0, 300));
      await release();
      return "post_failed";
    }
  } catch (err) {
    console.error("voice-capacity-alert: send threw", err);
    await release();
    return "post_failed";
  }
  return "sent";
}
