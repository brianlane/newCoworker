/**
 * Opt-in "client replied" owner alert — KYP feedback, Jul 20 2026: James,
 * working a live thread, missed Tim Tsai's replies ("You need to let me
 * know when clients text back i didnt see his texts"); the AI promised
 * immediate alerts, but no per-client-reply owner notification existed.
 *
 * DETERMINISTIC pipeline code, not a model tool: the sms-inbound-worker
 * calls this the moment a claimed job is identified as a CUSTOMER inbound,
 * BEFORE the reply branches — so flow-suppressed inbounds, tapbacks, and
 * bare "1" confirmation replies alert too. A model-invoked tool would fire
 * only when the model chose to call it (the same unreliability that
 * produced the Jul 16 notify_team misfire).
 *
 * Guard rails, in order:
 *   1. the toggle READS FAIL CLOSED: `customer_reply_alerts` is opt-in
 *      (default false) — a DB blip or missing prefs row means no alert;
 *   2. forward_owner contacts are skipped — the owner already receives
 *      those texts verbatim through the relay;
 *   3. per-JOB dedupe against the notifications history (payload->>jobId,
 *      DELIVERED rows only): a retried job whose first claim already paged
 *      never re-pages, while a retry whose first claim FAILED to page
 *      (notify POST down, worker crash) still alerts — an attempt-count
 *      gate here would silently drop those (Bugbot Medium on PR #802);
 *   4. per-contact coalescing (payload->>contactE164, DELIVERED rows only),
 *      so a multi-part text or a rapid back-and-forth is ONE page, not a
 *      storm.
 *
 * Best-effort throughout: an alert failure must never break the reply turn
 * that discovered it. Dependency-injected (client + fetch) so this is
 * unit-tested from vitest (tests/customer-reply-alert.test.ts).
 */

/** coworker_logs-shaped task_type routed through the notifications function. */
export const CUSTOMER_REPLY_TASK_TYPE = "sms_customer_reply";

/** Per-contact coalescing window: one page per engagement burst. */
export const CUSTOMER_REPLY_COALESCE_MINUTES = 10;

// Minimal structural client (the _shared convention).
// deno-lint-ignore no-explicit-any
type AnyClient = any;

export type CustomerReplyAlertInput = {
  businessId: string;
  /** The texter's number (the inbound `from`). */
  contactE164: string;
  /** The inbound message (clipped here). */
  inboundPreview: string;
  /** The sms_inbound_jobs id — the per-job dedupe key across retry claims. */
  jobId: string;
  /** `${SUPABASE_URL}/functions/v1/notifications` */
  notifyUrl: string;
  /** Service-role key or NOTIFICATIONS_WEBHOOK_TOKEN. */
  bearer: string;
  fetchFn?: typeof fetch;
};

export type CustomerReplyAlertResult =
  | "sent"
  | "already_alerted"
  | "opted_out"
  | "forward_owner"
  | "coalesced"
  | "post_failed";

/**
 * Page the owner that a client texted back, if (and only if) they opted in.
 * Never throws.
 */
export async function sendCustomerReplyAlert(
  supabase: AnyClient,
  input: CustomerReplyAlertInput
): Promise<CustomerReplyAlertResult> {
  try {
    // Opt-in gate — FAILS CLOSED. Default-false column; a read error or a
    // business that never opened the notifications page means no alert.
    const { data: prefs, error: prefsErr } = await supabase
      .from("notification_preferences")
      .select("customer_reply_alerts")
      .eq("business_id", input.businessId)
      .maybeSingle();
    if (prefsErr) {
      console.error("customer_reply_alert: prefs read", prefsErr);
      return "opted_out";
    }
    if ((prefs as { customer_reply_alerts?: boolean } | null)?.customer_reply_alerts !== true) {
      return "opted_out";
    }

    // Contact label + forward_owner gate, alias-aware (a merged number
    // resolves to the surviving row). A read failure degrades to the bare
    // number label — silence is the worse failure.
    const { data: contactRow, error: contactErr } = await supabase
      .from("contacts")
      .select("display_name, sms_reply_mode")
      .eq("business_id", input.businessId)
      .or(`customer_e164.eq.${input.contactE164},alias_e164s.cs.{${input.contactE164}}`)
      .maybeSingle();
    if (contactErr) {
      console.error("customer_reply_alert: contact lookup", contactErr);
    }
    const contact = contactRow as {
      display_name?: string | null;
      sms_reply_mode?: string | null;
    } | null;
    if (contact?.sms_reply_mode === "forward_owner") return "forward_owner";
    const label = contact?.display_name?.trim() || input.contactE164;

    // Per-JOB dedupe: a DELIVERED page for this exact inbound means a retry
    // claim must not re-page — but a retry whose FIRST claim never managed
    // to page (notify POST down, worker crash) still alerts. An
    // attempt-count gate would silently drop those (Bugbot Medium, PR #802).
    // A lookup error logs and still alerts — the coalesce below still
    // bounds any duplicate to one per window.
    const { data: priorForJob, error: priorErr } = await supabase
      .from("notifications")
      .select("id")
      .eq("business_id", input.businessId)
      .eq("status", "sent")
      .eq("payload->>taskType", CUSTOMER_REPLY_TASK_TYPE)
      .eq("payload->>jobId", input.jobId)
      .limit(1);
    if (priorErr) {
      console.error("customer_reply_alert: job dedupe lookup", priorErr);
    } else if (((priorForJob ?? []) as unknown[]).length > 0) {
      return "already_alerted";
    }

    // Coalesce: a DELIVERED page for this contact inside the window means
    // this burst already alerted (skipped/failed channel rows must not
    // suppress a retry that could actually reach the owner — same rule as
    // _shared/needs_human.ts). A lookup error logs and still alerts.
    const sinceIso = new Date(
      Date.now() - CUSTOMER_REPLY_COALESCE_MINUTES * 60_000
    ).toISOString();
    const { data: recent, error: recentErr } = await supabase
      .from("notifications")
      .select("id")
      .eq("business_id", input.businessId)
      .eq("status", "sent")
      .eq("payload->>taskType", CUSTOMER_REPLY_TASK_TYPE)
      .eq("payload->>contactE164", input.contactE164)
      .gte("created_at", sinceIso)
      .limit(1);
    if (recentErr) {
      console.error("customer_reply_alert: coalesce lookup", recentErr);
    } else if (((recent ?? []) as unknown[]).length > 0) {
      return "coalesced";
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
          task_type: CUSTOMER_REPLY_TASK_TYPE,
          status: "urgent_alert",
          log_payload: {
            contact_e164: input.contactE164,
            contact_label: label,
            inbound_preview: input.inboundPreview.slice(0, 200),
            job_id: input.jobId
          },
          created_at: new Date().toISOString()
        }
      })
    });
    if (!res.ok) {
      console.error("customer_reply_alert: notify post failed", res.status);
      return "post_failed";
    }
    return "sent";
  } catch (e) {
    console.error("sendCustomerReplyAlert", e);
    return "post_failed";
  }
}
