/**
 * Email fallback for owner-directed notify texts that SMS cannot deliver.
 *
 * Born from two incidents on the same account (KYP Ads):
 *   - Aug 6 2026: a platform-side Telnyx misconfiguration made every
 *     Canadian SMS fail with 40309; James's notify_owner alerts burned all
 *     retries and he never learned a new customer had arrived.
 *   - The standing case: an owner whose forwarding number is outside NANP
 *     (James is relocating to Hong Kong) can NEVER receive our SMS, since
 *     the platform's long codes are domestic-only.
 *
 * In both cases the notify content should still reach the owner. This
 * module routes it through the notifications Edge function so the email
 * leg (and dashboard row) deliver with the owner's existing preference
 * gates, audit rows, and unsubscribe handling. The notifications function
 * suppresses its own SMS leg for this task_type: the SMS path is exactly
 * what failed.
 *
 * The `reason` decides the explanation the owner sees, and blame follows
 * fault: "sms_unreachable" (their number cannot receive our texts, a state
 * they chose and were warned about at save time) explains what to fix;
 * "sms_rejected" (the carrier refused, could be our fault) stays neutral
 * and never tells the owner their number is broken; "no_phone" invites
 * them to add a number.
 *
 * Per run+step dedupe against DELIVERED rows, so a run retried after a
 * later step's crash cannot email the same notify twice. Best-effort:
 * callers decide whether a failed post falls back to the old behavior.
 * Dependency-injected (client + fetch) for unit tests.
 */

/** coworker_logs-shaped task_type routed through the notifications function. */
export const OWNER_NOTIFY_FALLBACK_TASK_TYPE = "owner_notify_fallback";

export type OwnerNotifyFallbackReason = "sms_unreachable" | "sms_rejected" | "no_phone";

// Minimal structural client (the _shared convention).
// deno-lint-ignore no-explicit-any
type AnyClient = any;

export type OwnerNotifyFallbackInput = {
  businessId: string;
  runId: string;
  stepIndex: number;
  /** The notify_owner message, verbatim (untracked long URLs are fine in email). */
  message: string;
  reason: OwnerNotifyFallbackReason;
  /** The unreachable/rejected number, for the audit payload. */
  phone?: string | null;
  /** Carrier detail for sms_rejected (clipped; never shown to the owner). */
  detail?: string | null;
  /** `${SUPABASE_URL}/functions/v1/notifications` */
  notifyUrl: string;
  /** Service-role key or NOTIFICATIONS_WEBHOOK_TOKEN. */
  bearer: string;
  fetchFn?: typeof fetch;
};

export type OwnerNotifyFallbackResult = "sent" | "already_sent" | "post_failed";

/**
 * Deliver an owner notify by email (+ dashboard) when SMS cannot. Never
 * throws; "post_failed" tells the caller nothing reached the owner.
 */
export async function sendOwnerNotifyFallback(
  supabase: AnyClient,
  input: OwnerNotifyFallbackInput
): Promise<OwnerNotifyFallbackResult> {
  try {
    // Per run+step dedupe: a DELIVERED row means the owner already has this
    // exact notify (skipped/failed rows must not suppress a retry that
    // could actually reach them, same rule as _shared/needs_human.ts).
    const { data: prior, error: priorErr } = await supabase
      .from("notifications")
      .select("id")
      .eq("business_id", input.businessId)
      .eq("status", "sent")
      .eq("payload->>taskType", OWNER_NOTIFY_FALLBACK_TASK_TYPE)
      .eq("payload->>runId", input.runId)
      .eq("payload->>stepIndex", String(input.stepIndex))
      .limit(1);
    if (priorErr) {
      console.error("owner_notify_fallback: dedupe lookup", priorErr);
    } else if (((prior ?? []) as unknown[]).length > 0) {
      return "already_sent";
    }

    const doFetch = input.fetchFn ?? fetch;
    const res = await doFetch(input.notifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.bearer}`
      },
      body: JSON.stringify({
        type: "INSERT",
        table: "coworker_logs",
        record: {
          id: crypto.randomUUID(),
          business_id: input.businessId,
          task_type: OWNER_NOTIFY_FALLBACK_TASK_TYPE,
          status: "urgent_alert",
          log_payload: {
            message: input.message.slice(0, 1000),
            reason: input.reason,
            phone: input.phone ?? null,
            detail: (input.detail ?? "").slice(0, 200) || null,
            run_id: input.runId,
            step_index: input.stepIndex
          },
          created_at: new Date().toISOString()
        }
      })
    });
    if (!res.ok) {
      console.error("owner_notify_fallback: notify post failed", res.status);
      return "post_failed";
    }
    return "sent";
  } catch (e) {
    console.error("sendOwnerNotifyFallback", e);
    return "post_failed";
  }
}
