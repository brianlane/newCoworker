/**
 * Opt-in owner alert for permanently failed (dead-lettered) lead-intake
 * AiFlow runs — Truly Insurance feedback, 2026-07-13.
 *
 * A failed `tenant_email` / `webhook` run means a lead form arrived and the
 * automation died: previously the only trace was an error-level system log
 * nobody watches (PR #558 gave dead-lettered customer TEXTS an owner page;
 * flow runs never got the same treatment). This module notifies the owner
 * through the notifications Edge function (SMS / email / dashboard per
 * their channel preferences) — but ONLY when the business explicitly opted
 * in via `notification_preferences.aiflow_failure_alerts` (default false).
 *
 * Guard rails, in order:
 *   1. lead-intake triggers only (tenant_email / webhook) — contact-event,
 *      manual, and scheduled runs re-run routinely and have their own
 *      surfaces;
 *   2. never for simulated test runs (trigger.test_mode);
 *   3. the toggle READ FAILS CLOSED: a DB blip or missing prefs row means
 *      no alert, never accidental spam;
 *   4. per-run dedupe against the notifications history (payload->>runId),
 *      so a re-entrant terminal write can't page twice.
 *
 * Best-effort throughout: an alert failure must never break the failRun
 * path that discovered it. Dependency-injected (client + fetch) so this is
 * unit-tested under the shared 100% coverage gate.
 */

/** coworker_logs-shaped task_type routed through the notifications function. */
export const AIFLOW_FAILURE_TASK_TYPE = "aiflow_run_failed";

/** Trigger channels that represent an inbound lead (the guarded class). */
const LEAD_INTAKE_CHANNELS = ["tenant_email", "webhook"];

// Minimal structural client (the _shared convention).
// deno-lint-ignore no-explicit-any
type AnyClient = any;

export type AiflowFailureAlertInput = {
  businessId: string;
  runId: string;
  flowId: string;
  /** The run's trigger scope (channel + optional test_mode marker). */
  trigger: Record<string, unknown> | null | undefined;
  /** The run's extracted vars (lead_name / lead_phone, when present). */
  vars: Record<string, unknown> | null | undefined;
  /** The readable failure reason failRun recorded (clipped here). */
  error: string;
  /** `${SUPABASE_URL}/functions/v1/notifications` */
  notifyUrl: string;
  /** Service-role key or NOTIFICATIONS_WEBHOOK_TOKEN. */
  bearer: string;
  fetchFn?: typeof fetch;
};

export type AiflowFailureAlertResult =
  | "sent"
  | "not_lead_intake"
  | "test_mode"
  | "opted_out"
  | "already_alerted"
  | "post_failed";

/**
 * Human label for the lead this run was handling, when extraction got far
 * enough. Falls back through the booking-flow var names (invitee_*) and the
 * lead's email, so a failed booking-confirmation run says who it was for
 * instead of "an unidentified lead" (the Jul 22 2026 KYP alerts named nobody
 * even though invitee_name was extracted). Extractors write the literal
 * string "none" for absent fields — treated as empty here.
 */
export function describeLead(vars: Record<string, unknown> | null | undefined): string {
  const read = (...keys: string[]): string => {
    for (const key of keys) {
      const v = vars?.[key];
      const s = typeof v === "string" ? v.trim() : "";
      if (s && s.toLowerCase() !== "none") return s;
    }
    return "";
  };
  const name = read("lead_name", "invitee_name");
  const contact = read("lead_phone", "invitee_phone") || read("lead_email", "invitee_email");
  if (name && contact) return `${name} (${contact})`;
  return name || contact || "an unidentified lead";
}

/**
 * Notify the owner that a lead-intake run dead-lettered, if (and only if)
 * they opted in. Never throws.
 */
export async function sendAiflowFailureAlert(
  supabase: AnyClient,
  input: AiflowFailureAlertInput
): Promise<AiflowFailureAlertResult> {
  try {
    const channel =
      typeof input.trigger?.channel === "string" ? (input.trigger.channel as string) : "";
    if (!LEAD_INTAKE_CHANNELS.includes(channel)) return "not_lead_intake";
    if (input.trigger?.test_mode === true || input.trigger?.test_mode === "true") {
      return "test_mode";
    }

    // Opt-in gate — FAILS CLOSED. Default-false column; a read error or a
    // business that never opened the notifications page means no alert.
    const { data: prefs, error: prefsErr } = await supabase
      .from("notification_preferences")
      .select("aiflow_failure_alerts")
      .eq("business_id", input.businessId)
      .maybeSingle();
    if (prefsErr) {
      console.error("aiflow_failure_alert: prefs read", prefsErr);
      return "opted_out";
    }
    if ((prefs as { aiflow_failure_alerts?: boolean } | null)?.aiflow_failure_alerts !== true) {
      return "opted_out";
    }

    // Per-run dedupe: a DELIVERED page for this run means the owner already
    // knows (skipped/failed channel rows must not suppress a retry that
    // could actually reach them — same rule as _shared/needs_human.ts).
    const { data: prior, error: priorErr } = await supabase
      .from("notifications")
      .select("id")
      .eq("business_id", input.businessId)
      .eq("status", "sent")
      .eq("payload->>taskType", AIFLOW_FAILURE_TASK_TYPE)
      .eq("payload->>runId", input.runId)
      .limit(1);
    if (priorErr) {
      console.error("aiflow_failure_alert: dedupe lookup", priorErr);
    } else if (((prior ?? []) as unknown[]).length > 0) {
      return "already_alerted";
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
          task_type: AIFLOW_FAILURE_TASK_TYPE,
          status: "urgent_alert",
          log_payload: {
            run_id: input.runId,
            flow_id: input.flowId,
            lead_label: describeLead(input.vars),
            reason: input.error.slice(0, 300)
          },
          created_at: new Date().toISOString()
        }
      })
    });
    if (!res.ok) {
      console.error("aiflow_failure_alert: notify post failed", res.status);
      return "post_failed";
    }
    return "sent";
  } catch (e) {
    console.error("sendAiflowFailureAlert", e);
    return "post_failed";
  }
}
