// Supabase Edge Function: notifications
// Triggered via Supabase Database Webhook on coworker_logs INSERT
// where status = 'urgent_alert', or directly by VPS heartbeat / OpenClaw
// scripts that POST a coworker_logs-shaped payload.
//
// Required Edge Function Secrets:
//   SUPABASE_URL              (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY (auto-injected)
//   TELNYX_API_KEY
//   TELNYX_MESSAGING_PROFILE_ID
//   TELNYX_SMS_FROM_E164 (optional if profile has default from)
//   TELNYX_OWNER_PHONE
//   RESEND_API_KEY
//   MAILER_EMAIL
//   CONTACT_EMAIL (optional; reply-to address)
//   ADMIN_EMAIL
//   NEXT_PUBLIC_APP_URL
//   NOTIFICATIONS_WEBHOOK_TOKEN (optional; for heartbeat script calls)
//
// Behavior parity with src/lib/notifications/dispatch.ts (Vercel side):
// recipient resolution prefers per-business preferences
// (alert_email/phone_number) over businesses.owner_email + env fallbacks,
// honors the four channel toggles plus `unsubscribed_at`, and writes one
// `notifications` row per channel attempt (sent / failed / skipped) so the
// dashboard "Recent notifications" list is the source of truth regardless
// of whether the alert was triggered through Vercel or through this Edge
// function.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.0";
import { buildBrandedEmailHtml } from "../_shared/branded_email_html.ts";
import { oneLineSubject } from "../_shared/email_subject.ts";
import { normalizeE164 } from "../_shared/normalize_e164.ts";
import { truncateAtWord } from "../_shared/text_truncate.ts";
import {
  CONTACT_SCOPED_TASK_TYPES,
  resolveContactOwnerTarget,
  type ContactOwnerTarget
} from "../_shared/contact_owner_target.ts";
import {
  meterOperationalSms,
  releaseOperationalSms
} from "../_shared/sms_operational_meter.ts";
import { smsTextUnits } from "../_shared/sms_text_units.ts";
import {
  notificationMustBePhiFree,
  phiFreeNotificationCopy
} from "../_shared/hipaa_notification_redaction.ts";
import { resolveInternationalFrom } from "../_shared/sms_international_gateway.ts";
import { smsDestinationCountry } from "../_shared/sms_destination_rates.ts";
import { alphaOwnerAlertProfile, withAlphaNoReplyLine } from "../_shared/alpha_sender.ts";
import { systemLog } from "../_shared/system_log.ts";

interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  record: {
    id: string;
    business_id: string;
    task_type: string;
    status: string;
    log_payload: Record<string, unknown>;
    created_at: string;
  };
}

type DeliveryChannel =
  | "sms"
  | "email"
  | "dashboard"
  | "whatsapp"
  | "slack"
  | "telegram"
  | "teams"
  | "google_chat"
  | "push";
type DeliveryStatus = "queued" | "sent" | "failed" | "skipped";

type ResolvedTargets = {
  email: string | null;
  /**
   * `businesses.hipaa_mode`. UNDEFINED (not false) when the row could not be
   * read; notificationMustBePhiFree treats unknown as "redact".
   */
  hipaaMode?: boolean;
  phone: string | null;
  smsUrgent: boolean;
  whatsappUrgent: boolean;
  /**
   * Deliver urgent alerts on WhatsApp INSTEAD of SMS. Honored only while
   * WhatsApp can actually deliver (connected + channel on), never for
   * alerts redirected to a teammate's phone. Mirrors dispatch.ts.
   */
  whatsappReplacesSms: boolean;
  slackUrgent: boolean;
  pushUrgent: boolean;
  pushReplacesSms: boolean;
  telegramUrgent: boolean;
  teamsUrgent: boolean;
  googleChatUrgent: boolean;
  emailUrgent: boolean;
  dashboardAlerts: boolean;
  unsubscribed: boolean;
  /**
   * How a contact-scoped alert was routed. Null for the business-level
   * alerts (billing, plan, system health), which never redirect.
   */
  routing: ContactOwnerTarget | null;
};

async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function verifyRequest(req: Request): Promise<boolean> {
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const webhookToken = Deno.env.get("NOTIFICATIONS_WEBHOOK_TOKEN") ?? "";

  const tokenHash = await sha256(token);

  if (serviceKey) {
    const serviceHash = await sha256(serviceKey);
    if (constantTimeEqual(tokenHash, serviceHash)) return true;
  }

  if (webhookToken) {
    const webhookHash = await sha256(webhookToken);
    if (constantTimeEqual(tokenHash, webhookHash)) return true;
  }

  return false;
}

// ─── Unsubscribe URL ─────────────────────────────────────────────────────────
// Plain `?bid=<businessId>` parameter, no HMAC. UUID v4 is unguessable and
// the unsubscribe action is a one-click flag the owner can re-enable from the
// dashboard. See src/app/api/notifications/unsubscribe/route.ts for the
// matching handler / threat-model rationale.
function buildUnsubscribeUrl(businessId: string, appUrl: string): string {
  // appUrl is normalized (trailing slash stripped) at the call site.
  return `${appUrl}/api/notifications/unsubscribe?bid=${encodeURIComponent(businessId)}`;
}

// See ai-flow-worker: ReturnType<typeof createClient> mis-resolves vs the real
// createClient() call, so use a permissive client type for helper params.
type SupaClient = SupabaseClient<any, any, any>;

/**
 * Where this alert goes. Business preferences first, then the business's
 * onboarding email, then env-level operator fallbacks, and, when the alert
 * is ABOUT one contact, redirected to whichever teammate owns that contact.
 * Deno mirror of resolveNotificationTargets in
 * src/lib/notifications/dispatch.ts; both import the same resolver so the
 * two pipelines route identically.
 */
async function resolveTargets(
  supa: SupaClient,
  businessId: string,
  contactE164?: string | null
): Promise<ResolvedTargets> {
  const fallbackEmail = (Deno.env.get("ADMIN_EMAIL") ?? "").trim() || null;
  const fallbackPhone = normalizeE164(Deno.env.get("TELNYX_OWNER_PHONE") ?? "");
  let prefsEmail: string | null = null;
  let prefsPhone: string | null = null;
  let smsUrgent = true;
  let whatsappUrgent = true;
  // Reroute preference defaults OFF (fail toward delivering on both
  // channels), unlike the channel toggles which fail toward on.
  let whatsappReplacesSms = false;
  let slackUrgent = true;
  let pushUrgent = true;
  let pushReplacesSms = false;
  let telegramUrgent = true;
  let teamsUrgent = true;
  let googleChatUrgent = true;
  let emailUrgent = true;
  let dashboardAlerts = true;
  let unsubscribed = false;
  let ownerEmail: string | null = null;

  const { data: prefs } = await supa
    .from("notification_preferences")
    .select(
      "alert_email, phone_number, sms_urgent, whatsapp_urgent, whatsapp_replaces_sms, slack_urgent, push_urgent, push_replaces_sms, telegram_urgent, teams_urgent, google_chat_urgent, email_urgent, dashboard_alerts, unsubscribed_at"
    )
    .eq("business_id", businessId)
    .maybeSingle();

  if (prefs) {
    prefsEmail = ((prefs.alert_email as string | null) ?? "").trim() || null;
    // Read-time E.164 normalization, mirroring resolveNotificationTargets in
    // src/lib/notifications/dispatch.ts: pre-validation rows (e.g. a bare
    // "6026951142") must still deliver instead of failing at Telnyx with
    // 40310. An uncoercible value degrades to null → honest `no_phone` skip.
    prefsPhone = normalizeE164(((prefs.phone_number as string | null) ?? "").trim());
    smsUrgent = Boolean(prefs.sms_urgent);
    // ?? true: rows read before the whatsapp_urgent column existed keep the
    // channel on (delivery still requires a connected WhatsApp integration).
    whatsappUrgent = Boolean(prefs.whatsapp_urgent ?? true);
    // ?? false: rows read before 20260822125053 keep SMS delivery unchanged.
    whatsappReplacesSms = Boolean(prefs.whatsapp_replaces_sms ?? false);
    // ?? true: rows read before 20260822113305, same posture.
    slackUrgent = Boolean(prefs.slack_urgent ?? true);
    // ?? true: rows read before 20260829044308, same posture.
    pushUrgent = Boolean(prefs.push_urgent ?? true);
    // ?? false: rows read before 20260829182428 keep SMS delivery unchanged.
    pushReplacesSms = Boolean(prefs.push_replaces_sms ?? false);
    telegramUrgent = Boolean(prefs.telegram_urgent ?? true);
    teamsUrgent = Boolean(prefs.teams_urgent ?? true);
    googleChatUrgent = Boolean(prefs.google_chat_urgent ?? true);
    emailUrgent = Boolean(prefs.email_urgent);
    dashboardAlerts = Boolean(prefs.dashboard_alerts);
    unsubscribed = Boolean(prefs.unsubscribed_at);
  }

  const { data: business } = await supa
    .from("businesses")
    .select("owner_email, hipaa_mode")
    .eq("id", businessId)
    .maybeSingle();
  // Left UNDEFINED when no row came back, so notificationMustBePhiFree can
  // fail closed on an unreadable business rather than assuming "not HIPAA".
  let hipaaMode: boolean | undefined;
  if (business) {
    ownerEmail = ((business.owner_email as string | null) ?? "").trim() || null;
    hipaaMode = business.hipaa_mode === true;
  }

  const ownerAlertEmail = prefsEmail ?? ownerEmail ?? fallbackEmail;
  const ownerAlertPhone = prefsPhone ?? fallbackPhone;

  // Contact-scoped alerts belong to whoever owns the lead. Never throws;
  // every failure resolves back to the business owner.
  const routing = contactE164
    ? await resolveContactOwnerTarget(supa, businessId, contactE164)
    : null;
  const redirected = routing?.target === "contact_owner";

  return {
    // Email redirects only when the roster row actually has an address;
    // otherwise it stays with the owner so a redirected alert keeps a second
    // delivery path.
    email: routing?.emailTarget === "contact_owner" ? routing.email : ownerAlertEmail,
    phone: redirected ? routing!.phone : ownerAlertPhone,
    smsUrgent,
    whatsappUrgent,
    whatsappReplacesSms,
    slackUrgent,
    pushUrgent,
    pushReplacesSms,
    telegramUrgent,
    teamsUrgent,
    googleChatUrgent,
    emailUrgent,
    dashboardAlerts,
    unsubscribed,
    routing,
    hipaaMode
  };
}

/**
 * One channel's outcome, in memory, alongside the row written for it.
 *
 * The rows alone cannot answer "did this alert reach anybody", because
 * answering that means looking at ALL of them together, and each leg writes
 * its own in isolation. Mirrors the `results` array the Node dispatcher
 * accumulates for exactly the same reason.
 */
type ChannelOutcome = {
  channel: DeliveryChannel;
  status: DeliveryStatus;
  reason?: string;
};

/**
 * The client plus the per-dispatch outcome list.
 *
 * Bundled into one parameter rather than threaded as a second argument
 * because `recordRow` is called from nine legs in several branches each, and
 * an accumulator that any one of them could forget to pass is an accumulator
 * that will eventually be wrong. Request-scoped, never module-scope: one
 * isolate serves concurrent requests, so shared mutable state here would mix
 * one tenant's outcomes into another's alert.
 */
type RecordCtx = {
  supa: SupaClient;
  outcomes: ChannelOutcome[];
};

/**
 * Raise `alert_delivery_failed` when a channel did not deliver.
 *
 * THE EDGE PIPELINE HAD NO SUCH ALARM. The Node dispatcher has raised this
 * since it was written, but this mirror only accumulated an `errors` array,
 * returned it in the HTTP response, and dropped it on the floor: the webhook
 * caller is pg_net or a VPS script, and nothing reads what it answers. So an
 * alert raised through the edge function that failed on EVERY channel told
 * nobody, while the per-channel `notifications` rows sat there honestly
 * recording `failed` on a page no one had a reason to open.
 *
 * `errors` was not usable as the source of truth either, and this is the
 * subtle half. It is pushed on transport failures only, so a leg that records
 * a `failed` row through its structured-outcome branch (the push bridge
 * answering ok:false with reason send_failed, for one) never appears in it.
 * Reading the recorded outcomes instead means the alarm and the rows can
 * never disagree.
 *
 * Wording and payload shape are copied from reportFailedChannels in
 * src/lib/notifications/dispatch.ts on purpose: both pipelines write to the
 * same admin card, and an operator should not be able to tell which one
 * raised the row.
 */
async function reportFailedChannels(
  ctx: RecordCtx,
  businessId: string,
  kind: string,
  summary: string
): Promise<void> {
  const failed = ctx.outcomes.filter((o) => o.status === "failed");
  if (failed.length === 0) return;
  const delivered = ctx.outcomes.filter((o) => o.status === "sent");
  await systemLog(ctx.supa, {
    businessId,
    level: "error",
    source: "notifications",
    event: "alert_delivery_failed",
    message:
      (delivered.length === 0
        ? "An urgent alert reached NOBODY: "
        : "An urgent alert failed on some channels: ") +
      failed.map((f) => `${f.channel} (${f.reason ?? "no reason given"})`).join(", ") +
      (delivered.length > 0
        ? `. Delivered on ${delivered.map((d) => d.channel).join(", ")}.`
        : "."),
    payload: {
      kind,
      summary,
      failedChannels: failed.map((f) => ({ channel: f.channel, reason: f.reason ?? null })),
      deliveredChannels: delivered.map((d) => d.channel)
    }
  });
}

async function recordRow(
  ctx: RecordCtx,
  businessId: string,
  channel: DeliveryChannel,
  status: DeliveryStatus,
  summary: string,
  kind: string,
  payload: Record<string, unknown>,
  reason?: string,
  /**
   * Pin the row's primary key instead of minting one here.
   *
   * Only the push leg passes it. The service worker posts the notification id
   * back as the click receipt, so the id has to travel WITH the push, which
   * means it must exist BEFORE the row is written. Mirrors the identical
   * trailing parameter on recordRow in src/lib/notifications/dispatch.ts.
   */
  rowId?: string
): Promise<void> {
  // Recorded whether or not the insert below lands, matching the Node
  // dispatcher: this is the CHANNEL's outcome, not the row's. A history write
  // that fails is a persistence bug, and it must not also erase our knowledge
  // that the alert itself failed to reach anyone.
  ctx.outcomes.push({ channel, status, reason });
  const id = rowId ?? crypto.randomUUID();
  const { error } = await ctx.supa.from("notifications").insert({
    id,
    business_id: businessId,
    delivery_channel: channel,
    status,
    kind,
    summary,
    payload: reason ? { ...payload, reason } : payload
  });
  if (error) {
    console.error("notifications.insert", channel, status, error);
  }
}

/**
 * Best-effort `sms_outbound_log` row for a Telnyx-accepted owner-alert SMS,
 * so the page renders in the owner's dashboard Messages thread (the thread
 * merges sms_inbound_jobs + sms_outbound_log, see src/lib/db/sms-history.ts).
 * Without this the only record of "the owner was paged" lived in Telnyx
 * (observed live: the Jul 17 2026 needs-human page was sent but invisible).
 * A logging failure must never fail the alert that already went out, same
 * convention as the ai-flow-worker's logOutboundSms.
 */
async function logOwnerAlertSms(
  supa: SupaClient,
  args: {
    businessId: string;
    to: string;
    from: string | null;
    body: string;
    telnyxMessageId: string | null;
  }
): Promise<void> {
  // Never throws: this runs inside the SMS-send try block AFTER Telnyx
  // accepted the alert, a thrown insert (network blip) would otherwise
  // trip the outer catch and record the delivered send as `failed`.
  try {
    const { error } = await supa.from("sms_outbound_log").insert({
      business_id: args.businessId,
      to_e164: args.to,
      from_e164: args.from,
      body: args.body,
      source: "owner_alert",
      telnyx_message_id: args.telnyxMessageId,
      channel: "sms"
    });
    if (error) {
      console.error("owner_alert sms_outbound_log insert", error);
    }
  } catch (e) {
    console.error("owner_alert sms_outbound_log insert threw", e);
  }
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!(await verifyRequest(req))) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { record } = payload;
  // Provisioning progress rows use thinking/success; never notify from these.
  if (record.task_type === "provisioning") {
    return new Response(JSON.stringify({ skipped: true, reason: "provisioning" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (record.status !== "urgent_alert") {
    return new Response(JSON.stringify({ skipped: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Usage-cap alerts carry owner-actionable copy instead of the generic
  // "URGENT <task_type>" headline, silence (blocked texts / degraded chat /
  // refused callers) must never be the only signal a cap was hit.
  const missedToday = Number(record.log_payload?.missed_calls_today ?? 0);
  // Needs-human escalations (see _shared/needs_human.ts): the texting
  // coworker hit something it couldn't handle and handed the conversation
  // to the owner, say who and why, not "URGENT sms_needs_human".
  const needsHumanLabel = String(record.log_payload?.contact_label ?? "a texter");
  // The model writes the reason as a full sentence ending in "." and the
  // summary template below appends its own, which used to yield
  // "follow-up.. Reply from Messages". Trim trailing periods here (and on
  // aiflowReason, same interpolation shape).
  const needsHumanReason = String(record.log_payload?.reason ?? "")
    .trim()
    .replace(/\.+$/, "");
  // Quote what the contact actually wrote (needs_human.ts always records the
  // preview): a label like "Clever Group Intro" alone tells the owner nothing
  // about WHO needs them when the contact is a shared vendor line or group
  // thread (Amy Laidlaw, Jul 31 2026).
  const needsHumanPreview = String(record.log_payload?.inbound_preview ?? "").trim();
  // AiFlow failure alerts (opt-in, _shared/aiflow_failure_alert.ts): a
  // lead-intake automation died, say which lead and why, not a raw task_type.
  const aiflowLeadLabel = String(record.log_payload?.lead_label ?? "a lead");
  const aiflowReason = String(record.log_payload?.reason ?? "")
    .trim()
    .replace(/\.+$/, "");
  // Customer reply alerts (opt-in, _shared/customer_reply_alert.ts): a
  // client texted back, say who and what they said (KYP, Jul 20 2026).
  const replyLabel = String(record.log_payload?.contact_label ?? "A contact");
  const replyPreview = String(record.log_payload?.inbound_preview ?? "").trim();
  // Owner-notify SMS fallback (_shared/owner_notify_fallback.ts): a
  // notify_owner text could not go by SMS, so the CONTENT arrives here and
  // the email carries a reason-matched explanation. Blame follows fault:
  // an unreachable (non-NANP) number the owner chose gets fix-it guidance;
  // a carrier rejection of a reachable number stays neutral, because that
  // can be our fault (the Aug 6 2026 Canada-whitelist outage) and "update
  // your number" would send the owner chasing a problem they don't have.
  const fallbackMessage = String(record.log_payload?.message ?? "").trim();
  const fallbackReason = String(record.log_payload?.reason ?? "");
  const fallbackNote =
    fallbackReason === "sms_unreachable"
      ? "This came by email because texts cannot reach your phone number: our texting lines only deliver to +1 (US and Canada) numbers. Update your forwarding number, or connect WhatsApp, to get alerts on your phone."
      : fallbackReason === "no_phone"
        ? "This came by email because no forwarding phone number is set. Add one on your dashboard to get alerts by text."
        : "This came by email because we could not deliver it to your phone by text.";
  const summary =
    record.task_type === "sms_cap_reached"
      ? "Monthly SMS limit reached; outbound texting is paused. Buy an SMS pack from Billing to resume."
      : record.task_type === "chat_spend_cap_reached"
        ? "AI chat budget reached; replies switched to the slower local model. Buy a Gemini pack from Billing to restore."
        : record.task_type === "missed_call_spike"
          ? `${missedToday || "Several"} callers were turned away today (line busy or out of voice minutes). Check Analytics on your dashboard; a plan upgrade or minutes top-up stops the misses.`
          : record.task_type === "sms_needs_human"
            ? truncateAtWord(`Your texting coworker needs you to take over with ${needsHumanLabel}${needsHumanReason ? `, ${needsHumanReason}` : ""}${needsHumanPreview ? `. They said: "${needsHumanPreview}"` : ""}. Reply from Messages on your dashboard.`, 320)
            : record.task_type === "aiflow_run_failed"
              ? truncateAtWord(`An AiFlow stopped while handling ${aiflowLeadLabel}${aiflowReason ? `, ${aiflowReason}` : ""}. Follow up with them yourself and check the flow's run history on your dashboard.`, 320)
              : record.task_type === "sms_customer_reply"
                ? truncateAtWord(`${replyLabel} texted back${replyPreview ? `: "${replyPreview}"` : ""}. Reply from Messages on your dashboard.`, 320)
                : record.task_type === "owner_notify_fallback"
                  ? truncateAtWord(fallbackMessage || "Your AI coworker has an update for you.", 320)
                  : `URGENT ${record.task_type}`;
  const kind = "urgent_alert";
  // Strip trailing slash so dashboardUrl never ends up as
  // `https://example.com//dashboard` if the env var was set with one.
  const appUrl = (Deno.env.get("NEXT_PUBLIC_APP_URL") ?? "https://www.newcoworker.com").replace(
    /\/$/,
    ""
  );
  const dashboardUrl = `${appUrl}/dashboard`;
  const cronSecret = (Deno.env.get("INTERNAL_CRON_SECRET") ?? "").trim();

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supa = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null;
  if (!supa || !record.business_id) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing_supabase_or_business_id" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Only alerts ABOUT one contact redirect to that contact's owner; billing,
  // plan and system-health alerts stay with the business owner.
  const scopedContactE164 =
    CONTACT_SCOPED_TASK_TYPES.has(record.task_type) && record.log_payload?.contact_e164
      ? String(record.log_payload.contact_e164)
      : null;
  const targets = await resolveTargets(supa, record.business_id, scopedContactE164);
  // HIPAA lane: every channel below hands content to a vendor that cannot
  // hold PHI. Shared with the Node dispatcher so the rule cannot drift
  // between the two implementations. `summary` itself stays intact: the
  // recordRow history lives in a store the BAA covers.
  const phiFree = notificationMustBePhiFree(targets.hipaaMode)
    ? phiFreeNotificationCopy(dashboardUrl)
    : null;
  const basePayload: Record<string, unknown> = {
    summary,
    logId: record.id,
    taskType: record.task_type,
    // Why this alert reached whoever it reached, mirrors the
    // notify_lead_owner step's target/matched_by.
    ...(targets.routing
      ? {
          routed_to: targets.routing.target,
          routed_member_id: targets.routing.memberId,
          routed_member_name: targets.routing.memberName,
          matched_by: targets.routing.matchedBy,
          routing_reason: targets.routing.reason
        }
      : {}),
    // Needs-human escalations and customer-reply alerts stamp the contact so
    // their per-contact dedupe/coalesce lookups (payload->>contactE164) can
    // find prior pages, see _shared/needs_human.ts and
    // _shared/customer_reply_alert.ts.
    ...((record.task_type === "sms_needs_human" || record.task_type === "sms_customer_reply") &&
    record.log_payload?.contact_e164
      ? { contactE164: String(record.log_payload.contact_e164) }
      : {}),
    // Team-first tenants whose handoff paged directly because no flow
    // enqueued carry the why on the row (see _shared/needs_human.ts).
    ...(record.task_type === "sms_needs_human" && record.log_payload?.team_first_fallthrough
      ? { team_first_fallthrough: true }
      : {}),
    // AiFlow failure alerts stamp the run so the alert module's per-run
    // dedupe (payload->>runId) can find prior delivered pages, see
    // _shared/aiflow_failure_alert.ts. The flow id rides along so the
    // notifications list can deep-link to that run's group on the runs page,
    // which needs flowId server-side to load it.
    ...(record.task_type === "aiflow_run_failed" && record.log_payload?.run_id
      ? { runId: String(record.log_payload.run_id) }
      : {}),
    ...(record.task_type === "aiflow_run_failed" && record.log_payload?.flow_id
      ? { flowId: String(record.log_payload.flow_id) }
      : {}),
    // Customer reply alerts stamp the inbound job so a RETRY claim of the
    // same job never re-pages (payload->>jobId), see
    // _shared/customer_reply_alert.ts.
    ...(record.task_type === "sms_customer_reply" && record.log_payload?.job_id
      ? { jobId: String(record.log_payload.job_id) }
      : {}),
    // Owner-notify fallbacks stamp run + step so the module's per-step
    // dedupe (payload->>runId + payload->>stepIndex) can find prior
    // delivered pages; see _shared/owner_notify_fallback.ts. The reason
    // rides along for the audit trail.
    ...(record.task_type === "owner_notify_fallback"
      ? {
          runId: String(record.log_payload?.run_id ?? ""),
          stepIndex: String(record.log_payload?.step_index ?? ""),
          fallbackReason
        }
      : {})
  };
  const errors: string[] = [];
  // Request-scoped. Every recordRow below appends its channel's outcome here,
  // and reportFailedChannels reads the whole set once the fan-out is done.
  const ctx: RecordCtx = { supa, outcomes: [] };

  // Transport-level dedupe (Amy Laidlaw, Jul 31 2026, four leads in one
  // week): persona-driven turns often call notify_team AND set reasoning
  // handoff for the same contact, which texted the claimed agent twice
  // within seconds ("[Coworker] Follow up ..." then "New Coworker Alert:
  // ... take over ..."). When a team-notify row about this contact was
  // DELIVERED within the last few minutes, the dashboard row still lands
  // but the sms/email/whatsapp transports record `recent_team_notify`
  // skips instead of re-sending. Fail-open: a lookup error never blocks
  // a page.
  const RECENT_TEAM_NOTIFY_MINUTES = 5;
  let suppressTransports = false;
  if (record.task_type === "sms_needs_human" && scopedContactE164) {
    const sinceIso = new Date(Date.now() - RECENT_TEAM_NOTIFY_MINUTES * 60_000).toISOString();
    const { data: recentNotify, error: recentNotifyErr } = await supa
      .from("notifications")
      .select("id")
      .eq("business_id", record.business_id)
      .eq("status", "sent")
      .in("kind", ["sms_team_notify", "voice_team_notify"])
      // The texting twin stores the contact as payload.customerPhone, the
      // voice twin as payload.callerPhone (their notify_team logPayloads
      // differ); match either. The notify_team routes normalize on write
      // now, but rows written before that (or via a non-coercible model
      // value) may carry bare NANP digits, so match those variants too.
      .or(
        [
          ...new Set(
            [
              scopedContactE164,
              scopedContactE164.replace(/\D/g, ""),
              /^\+1\d{10}$/.test(scopedContactE164) ? scopedContactE164.slice(2) : ""
            ].filter(Boolean)
          )
        ]
          .flatMap((c) => [`payload->>customerPhone.eq.${c}`, `payload->>callerPhone.eq.${c}`])
          .join(",")
      )
      .gte("created_at", sinceIso)
      .limit(1);
    if (recentNotifyErr) {
      console.error("notifications: recent team-notify lookup failed", recentNotifyErr);
    } else {
      suppressTransports = ((recentNotify ?? []) as unknown[]).length > 0;
    }
  }

  // 1) Dashboard channel
  if (targets.dashboardAlerts && !targets.unsubscribed) {
    await recordRow(ctx, record.business_id, "dashboard", "sent", summary, kind, basePayload);
  } else {
    await recordRow(
      ctx,
      record.business_id,
      "dashboard",
      "skipped",
      summary,
      kind,
      basePayload,
      targets.unsubscribed ? "unsubscribed" : "dashboard_alerts_disabled"
    );
  }

  // 2) SMS channel via Telnyx, with per-business messaging profile / from override
  let telnyxProfile = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") ?? "";
  let telnyxFrom = Deno.env.get("TELNYX_SMS_FROM_E164") ?? "";
  const { data: trow } = await supa
    .from("business_telnyx_settings")
    .select("telnyx_messaging_profile_id, telnyx_sms_from_e164")
    .eq("business_id", record.business_id)
    .maybeSingle();
  if (trow?.telnyx_messaging_profile_id) {
    telnyxProfile = String(trow.telnyx_messaging_profile_id);
  }
  if (trow?.telnyx_sms_from_e164) {
    telnyxFrom = String(trow.telnyx_sms_from_e164);
  }

  // "Has this business ever connected WhatsApp?", resolved BEFORE the SMS
  // branch because the whatsapp_replaces_sms preference may only suppress
  // SMS while the WhatsApp leg further down can actually fire.
  //
  // Two verdicts, DELIBERATELY OPPOSITE failure directions (mirrors
  // resolveNotificationTargets in src/lib/notifications/dispatch.ts):
  // `connected` decides whether to write a row at all and fails toward
  // true; `deliverable` decides whether to SUPPRESS the SMS leg and fails
  // toward false, because an inactive/expired connection refuses with
  // `connection_inactive` and suppressing SMS on that basis would leave the
  // owner with no phone channel at all.
  let whatsappConnected = true;
  let whatsappDeliverable = false;
  {
    const { data: waConn, error: waConnErr } = await supa
      .from("whatsapp_connections")
      .select("business_id, is_active")
      .eq("business_id", record.business_id)
      .maybeSingle();
    if (!waConnErr) {
      whatsappConnected = waConn !== null;
      whatsappDeliverable = waConn?.is_active === true;
    }
  }

  /**
   * Push liveness, resolved here rather than in the push leg because the SMS
   * leg below needs it first (push_replaces_sms).
   *
   * TWO flags failing in opposite directions, mirroring WhatsApp's pair.
   * `pushConnected` decides whether a business gets NO push row at all and
   * fails toward TRUE, so a read blip degrades to a noisy honest skip.
   * `pushDeliverable` gates SUPPRESSING the owner's text and fails toward
   * FALSE, because treating a blip as "yes" would silence the SMS on the
   * strength of a push nobody confirmed could land.
   *
   * Eligibility (roster role, not a leftover HQ view-as row) lives in
   * src/lib/push, which this file cannot import. An unfiltered live-row
   * check here used to treat a leaked admin device as deliverable, skip
   * the owner's text, then `/api/internal/push-send` would drop that row
   * and the owner would get neither channel. Ask the Node helper instead.
   */
  let pushConnected = true;
  let pushDeliverable = false;
  if (cronSecret && appUrl) {
    try {
      const stateRes = await fetch(`${appUrl}/api/internal/push-target-state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cronSecret}`,
          Origin: appUrl
        },
        body: JSON.stringify({ businessId: record.business_id })
      });
      const stateJson = stateRes.ok
        ? ((await stateRes.json().catch(() => null)) as {
            data?: { connected?: boolean; deliverable?: boolean };
          } | null)
        : null;
      if (
        typeof stateJson?.data?.connected === "boolean" &&
        typeof stateJson?.data?.deliverable === "boolean"
      ) {
        pushConnected = stateJson.data.connected;
        pushDeliverable = stateJson.data.deliverable;
      }
    } catch {
      // Leave the fail-open / fail-closed defaults.
    }
  }

  const telnyxKey = Deno.env.get("TELNYX_API_KEY");
  if (record.task_type === "owner_notify_fallback") {
    // The SMS path is exactly what failed (or cannot work) for this
    // record; attempting it again here would re-fail, or worse, double
    // text the owner. Email and dashboard are the point.
    await recordRow(
      ctx,
      record.business_id,
      "sms",
      "skipped",
      summary,
      kind,
      basePayload,
      "sms_fallback_source"
    );
  } else if (!targets.phone) {
    await recordRow(
      ctx,
      record.business_id,
      "sms",
      "skipped",
      summary,
      kind,
      basePayload,
      "no_phone"
    );
  } else if (!targets.smsUrgent || targets.unsubscribed) {
    await recordRow(
      ctx,
      record.business_id,
      "sms",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.phone },
      targets.unsubscribed ? "unsubscribed" : "sms_urgent_disabled"
    );
  } else if (suppressTransports) {
    await recordRow(
      ctx,
      record.business_id,
      "sms",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.phone },
      "recent_team_notify"
    );
  } else if (
    targets.pushReplacesSms &&
    pushDeliverable &&
    targets.pushUrgent &&
    // Never for an alert redirected to ONE teammate's phone: push fans out to
    // every subscribed device and cannot be aimed at that person. Mirrors
    // dispatch.ts, which additionally excludes team_broadcast; this pipeline
    // has no such routing.
    targets.routing?.target !== "contact_owner"
  ) {
    await recordRow(
      ctx,
      record.business_id,
      "sms",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.phone },
      "push_preferred"
    );
  } else if (
    targets.whatsappReplacesSms &&
    whatsappDeliverable &&
    targets.whatsappUrgent &&
    targets.routing?.target !== "contact_owner"
  ) {
    // WhatsApp-instead-of-SMS preference: gated on whatsappDeliverable, NOT
    // whatsappConnected, an inactive/token-lapsed row would otherwise
    // suppress SMS while the WhatsApp leg refuses, leaving no phone channel
    // (Bugbot f574b3a4). Never for an alert redirected to a teammate's
    // phone, whose number may not have WhatsApp at all. Mirrors dispatch.ts.
    await recordRow(
      ctx,
      record.business_id,
      "sms",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.phone },
      "whatsapp_preferred"
    );
  } else if (telnyxKey && telnyxProfile) {
    // An international owner phone with the alpha profile configured rides
    // the platform's one-way NEWCOWORKER sender (long codes cannot
    // originate international SMS: ticket #557577), with the no-reply line
    // appended because that sender has no inbound path. Env unset = null =
    // today's behavior. Owner alerts only by design (the RCS rule:
    // platform-branded senders never carry customer traffic).
    const alphaProfile = alphaOwnerAlertProfile(smsDestinationCountry(targets.phone));
    // Trim trailing periods so a "."-terminated summary can't produce
    // "dashboard.. Details:" (mirrors dispatch.ts). Built before the meter
    // so the counted units match the exact body sent.
    const alertLine =
      phiFree?.smsBody ?? `New Coworker Alert: ${summary.replace(/\.+$/, "")}. Details: ${dashboardUrl}`;
    const smsText = alphaProfile ? withAlphaNoReplyLine(alertLine) : alertLine;
    // Owner alerts are METERED against the tenant's monthly pool like all
    // traffic (Jul 14 2026 policy: nothing is exempt) but never REFUSED,
    // the "you hit your SMS cap" alert must outrun the cap it reports.
    // Declared OUTSIDE the try so the catch can release the counted slot
    // when the fetch itself throws (network error, nothing left Telnyx).
    const smsMeter = await meterOperationalSms(supa, record.business_id, smsTextUnits(smsText));
    // Slot lifecycle guard: set once the counted slot is SETTLED, either
    // kept (Telnyx accepted the alert) or already released (Telnyx
    // rejected it). A later throw in the same try (recordRow, error-body
    // read) re-enters the catch, which must neither refund a delivered
    // alert nor release the same slot twice.
    let smsMeterSettled = false;
    try {
      const body: Record<string, string> = {
        to: targets.phone,
        text: smsText,
        messaging_profile_id: alphaProfile ?? telnyxProfile
      };
      // An international alert phone (owner abroad) is only reachable via
      // the P2P gateway from-number.
      // On the alpha profile the sender IS the profile's alpha identity, so
      // no from-number rides along; otherwise the gateway/tenant rules apply.
      const alertFrom = alphaProfile
        ? null
        : resolveInternationalFrom(targets.phone, telnyxFrom || null);
      if (alertFrom) body.from = alertFrom;
      const smsRes = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${telnyxKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      if (!smsRes.ok) {
        // The alert never left Telnyx, give the counted slot back.
        await releaseOperationalSms(supa, record.business_id, smsMeter);
      }
      smsMeterSettled = true;
      if (smsRes.ok) {
        // Best-effort message-id extraction: a 2xx with an unparseable body
        // still logs the send (id null) rather than dropping the thread row.
        let telnyxMessageId: string | null = null;
        try {
          const smsJson = (await smsRes.json()) as { data?: { id?: string } };
          telnyxMessageId = smsJson?.data?.id ?? null;
        } catch {
          telnyxMessageId = null;
        }
        await logOwnerAlertSms(supa, {
          businessId: record.business_id,
          to: targets.phone,
          from: telnyxFrom || null,
          body: smsText,
          telnyxMessageId
        });
        await recordRow(
          ctx,
          record.business_id,
          "sms",
          "sent",
          summary,
          kind,
          { ...basePayload, recipient: targets.phone }
        );
      } else {
        const errBody = await smsRes.text().catch(() => "");
        errors.push(`SMS failed: ${smsRes.status}`);
        await recordRow(
          ctx,
          record.business_id,
          "sms",
          "failed",
          summary,
          kind,
          { ...basePayload, recipient: targets.phone },
          `telnyx_${smsRes.status}: ${errBody.slice(0, 200)}`
        );
      }
    } catch (e) {
      // Release ONLY when the slot is still unsettled (the fetch itself
      // threw, nothing left Telnyx). A delivered alert stays counted, and
      // an already-released slot is never released twice.
      if (!smsMeterSettled) {
        await releaseOperationalSms(supa, record.business_id, smsMeter);
      }
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`SMS error: ${msg}`);
      await recordRow(
        ctx,
        record.business_id,
        "sms",
        "failed",
        summary,
        kind,
        { ...basePayload, recipient: targets.phone },
        msg
      );
    }
  } else {
    await recordRow(
      ctx,
      record.business_id,
      "sms",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.phone },
      "telnyx_unconfigured"
    );
  }

  // 3) Email channel via Resend
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!targets.email) {
    await recordRow(
      ctx,
      record.business_id,
      "email",
      "skipped",
      summary,
      kind,
      basePayload,
      "no_email"
    );
  } else if (!targets.emailUrgent || targets.unsubscribed) {
    await recordRow(
      ctx,
      record.business_id,
      "email",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.email },
      targets.unsubscribed ? "unsubscribed" : "email_urgent_disabled"
    );
  } else if (suppressTransports) {
    await recordRow(
      ctx,
      record.business_id,
      "email",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.email },
      "recent_team_notify"
    );
  } else if (resendKey) {
    try {
      const unsubscribeUrl = buildUnsubscribeUrl(record.business_id, appUrl);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json"
      };
      const emailHeaders: Record<string, string> = {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
      };
      // Resend rejects subjects containing newlines (422 validation_error),
      // and alert summaries can embed multiline provider errors: the KYP
      // Telnyx 40310 alert email died exactly that way (Aug 1 2026). One
      // line, clipped; the body keeps the full summary.
      const subject = phiFree?.emailSubject ?? `Urgent: ${oneLineSubject(summary)}`;
      // Fallback records append the delivery explanation so the owner
      // knows why this arrived by email and (only when it is their number
      // that cannot work) what to change.
      const noteSuffix =
        record.task_type === "owner_notify_fallback" ? `\n\n${fallbackNote}` : "";
      const baseText =
        phiFree?.emailBody ??
        `Your AI Coworker flagged an urgent event.\n\nSummary: ${summary}\nBusiness ID: ${record.business_id}${noteSuffix}\n\nView details: ${dashboardUrl}`;
      const text = `${baseText}\n\n---\nDon't want these alerts? Unsubscribe: ${unsubscribeUrl}`;
      const html = buildBrandedEmailHtml({
        siteUrl: appUrl,
        documentTitle: subject,
        heading: phiFree?.emailHeading ?? subject,
        bodyBlocks: phiFree
          ? [{ kind: "text" as const, text: phiFree.emailBody }]
          : [
              { kind: "text", text: "Your AI Coworker flagged an urgent event." },
              { kind: "text", text: `Summary: ${summary}` },
              { kind: "text", text: `Business ID: ${record.business_id}` },
              ...(record.task_type === "owner_notify_fallback"
                ? [{ kind: "text" as const, text: fallbackNote }]
                : [])
            ],
        cta: { label: "Open dashboard", href: dashboardUrl },
        unsubscribeUrl,
        recipientEmail: targets.email
      });
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers,
        body: JSON.stringify({
          from:
            Deno.env.get("MAILER_EMAIL") ?? "New Coworker <contact@newcoworker.com>",
          to: targets.email,
          reply_to: Deno.env.get("CONTACT_EMAIL") ?? undefined,
          subject,
          text,
          html,
          headers: emailHeaders
        })
      });
      if (emailRes.ok) {
        await recordRow(
          ctx,
          record.business_id,
          "email",
          "sent",
          summary,
          kind,
          { ...basePayload, recipient: targets.email }
        );
      } else {
        const errBody = await emailRes.text().catch(() => "");
        errors.push(`Email failed: ${emailRes.status}`);
        await recordRow(
          ctx,
          record.business_id,
          "email",
          "failed",
          summary,
          kind,
          { ...basePayload, recipient: targets.email },
          `resend_${emailRes.status}: ${errBody.slice(0, 200)}`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Email error: ${msg}`);
      await recordRow(
        ctx,
        record.business_id,
        "email",
        "failed",
        summary,
        kind,
        { ...basePayload, recipient: targets.email },
        msg
      );
    }
  } else {
    await recordRow(
      ctx,
      record.business_id,
      "email",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.email },
      "resend_unconfigured"
    );
  }

  // 4) WhatsApp channel, delegated to the Next.js internal deliver
  // endpoint (Cloud API client, tenant token decryption, 24h-window +
  // template routing live there). Fully additive: no connected WhatsApp
  // integration comes back as a structured not_connected skip.
  //
  // A business that never connected WhatsApp records NOTHING here, and the
  // check is the OUTERMOST gate: it used to be reachable only on the
  // delivery path, so the no-phone, toggle-off and transport-dedupe branches
  // below kept writing whatsapp rows for tenants with no WhatsApp at all.
  // whatsappConnected itself is resolved above the SMS branch, which also
  // needs it for the whatsapp_replaces_sms preference.
  if (!whatsappConnected) {
    // Not applicable to this business: no row, no delivery attempt.
  } else if (!targets.phone) {
    await recordRow(
      ctx,
      record.business_id,
      "whatsapp",
      "skipped",
      summary,
      kind,
      basePayload,
      "no_phone"
    );
  } else if (!targets.whatsappUrgent || targets.unsubscribed) {
    await recordRow(
      ctx,
      record.business_id,
      "whatsapp",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.phone },
      targets.unsubscribed ? "unsubscribed" : "whatsapp_urgent_disabled"
    );
  } else if (suppressTransports) {
    await recordRow(
      ctx,
      record.business_id,
      "whatsapp",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.phone },
      "recent_team_notify"
    );
  } else if (cronSecret && appUrl) {
    try {
      const waRes = await fetch(`${appUrl}/api/internal/whatsapp-send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cronSecret}`,
          // CSRF gate: src/proxy.ts allows server-to-server bearer POSTs
          // only when Origin matches NEXT_PUBLIC_APP_URL.
          Origin: appUrl
        },
        body: JSON.stringify({
          businessId: record.business_id,
          to: targets.phone,
          text:
            phiFree?.smsBody ??
            `New Coworker Alert: ${summary.replace(/\.+$/, "")}. Details: ${dashboardUrl}`,
          audience: "owner"
        })
      });
      const waJson = waRes.ok
        ? ((await waRes.json().catch(() => null)) as {
            data?: { ok?: boolean; via?: string; reason?: string; messageId?: string | null };
          } | null)
        : null;
      if (waJson?.data?.ok) {
        await recordRow(
          ctx,
          record.business_id,
          "whatsapp",
          "sent",
          summary,
          kind,
          {
            ...basePayload,
            recipient: targets.phone,
            via: waJson.data.via ?? "text",
            // `sent` means Meta ACCEPTED it, not that it arrived. The wamid is
            // the only handle the failure receipt has on this row; without it
            // an alert Meta drops stays recorded as delivered. Mirrors
            // src/lib/notifications/dispatch.ts.
            ...(waJson.data.messageId ? { wamid: waJson.data.messageId } : {})
          }
        );
      } else if (waRes.ok) {
        // Structured policy skip (inactive connection / template in review).
        // A NEVER-connected business records nothing: the channel is not
        // applicable, and the skip row was pure noise on every alert
        // (mirrors src/lib/notifications/dispatch.ts).
        const waReason = waJson?.data?.reason ?? "send_failed";
        if (waReason !== "not_connected") {
          await recordRow(
            ctx,
            record.business_id,
            "whatsapp",
            waReason === "send_failed" ? "failed" : "skipped",
            summary,
            kind,
            { ...basePayload, recipient: targets.phone },
            waReason
          );
        }
      } else {
        errors.push(`WhatsApp failed: ${waRes.status}`);
        await recordRow(
          ctx,
          record.business_id,
          "whatsapp",
          "failed",
          summary,
          kind,
          { ...basePayload, recipient: targets.phone },
          `whatsapp_bridge_${waRes.status}`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`WhatsApp error: ${msg}`);
      await recordRow(
        ctx,
        record.business_id,
        "whatsapp",
        "failed",
        summary,
        kind,
        { ...basePayload, recipient: targets.phone },
        msg
      );
    }
  } else {
    await recordRow(
      ctx,
      record.business_id,
      "whatsapp",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.phone },
      "whatsapp_bridge_unconfigured"
    );
  }

  // 5) Slack channel, delegated to the Next.js internal endpoint (bot
  // token decryption + the Web API client live there, so no Slack secret
  // lands in an edge function). Same never-connected silence rule as
  // WhatsApp: a business with no slack_connections row records NOTHING
  // here; a connected workspace with a problem (uninstalled, no channel
  // picked, tier) records an honest skip row. Mirrors the fifth arm of
  // src/lib/notifications/dispatch.ts.
  let slackConnected = true;
  {
    const { data: slConn, error: slConnErr } = await supa
      .from("slack_connections")
      .select("business_id")
      .eq("business_id", record.business_id)
      .maybeSingle();
    if (!slConnErr) slackConnected = slConn !== null;
  }
  if (!slackConnected) {
    // Not applicable to this business: no row, no delivery attempt.
  } else if (!targets.slackUrgent || targets.unsubscribed) {
    await recordRow(
      ctx,
      record.business_id,
      "slack",
      "skipped",
      summary,
      kind,
      basePayload,
      targets.unsubscribed ? "unsubscribed" : "slack_urgent_disabled"
    );
  } else if (suppressTransports) {
    await recordRow(
      ctx,
      record.business_id,
      "slack",
      "skipped",
      summary,
      kind,
      basePayload,
      "recent_team_notify"
    );
  } else if (cronSecret && appUrl) {
    try {
      const slRes = await fetch(`${appUrl}/api/internal/slack-send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cronSecret}`,
          // CSRF gate: src/proxy.ts allows server-to-server bearer POSTs
          // only when Origin matches NEXT_PUBLIC_APP_URL.
          Origin: appUrl
        },
        body: JSON.stringify({
          businessId: record.business_id,
          text:
            phiFree?.smsBody ??
            `New Coworker Alert: ${summary.replace(/\.+$/, "")}. Details: ${dashboardUrl}`,
          // Same compact card buildSlackAlertBlocks renders on the Node
          // path, kept in lockstep so both pipelines look identical.
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*New Coworker Alert*\n${phiFree?.summary ?? summary}`
              }
            },
            {
              type: "context",
              elements: [{ type: "mrkdwn", text: `<${dashboardUrl}|Open dashboard>` }]
            }
          ]
        })
      });
      const slJson = slRes.ok
        ? ((await slRes.json().catch(() => null)) as {
            data?: {
              ok?: boolean;
              channelId?: string;
              channelName?: string | null;
              reason?: string;
              detail?: string;
            };
          } | null)
        : null;
      if (slJson?.data?.ok) {
        await recordRow(ctx, record.business_id, "slack", "sent", summary, kind, {
          ...basePayload,
          recipient: slJson.data.channelName
            ? `#${slJson.data.channelName}`
            : (slJson.data.channelId ?? "slack")
        });
      } else if (slRes.ok) {
        // Structured policy skip (needs reconnect / no channel / tier). A
        // NEVER-connected business records nothing (raced a disconnect).
        const slReason = slJson?.data?.reason ?? "send_failed";
        if (slReason !== "not_connected") {
          await recordRow(
            ctx,
            record.business_id,
            "slack",
            slReason === "send_failed" ? "failed" : "skipped",
            summary,
            kind,
            basePayload,
            slJson?.data?.detail ? `${slReason}:${slJson.data.detail}` : slReason
          );
        }
      } else {
        errors.push(`Slack failed: ${slRes.status}`);
        await recordRow(
          ctx,
          record.business_id,
          "slack",
          "failed",
          summary,
          kind,
          basePayload,
          `slack_bridge_${slRes.status}`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Slack error: ${msg}`);
      await recordRow(
        ctx,
        record.business_id,
        "slack",
        "failed",
        summary,
        kind,
        basePayload,
        msg
      );
    }
  } else {
    await recordRow(
      ctx,
      record.business_id,
      "slack",
      "skipped",
      summary,
      kind,
      basePayload,
      "slack_bridge_unconfigured"
    );
  }

  // Telegram, through /api/internal/telegram-send for the same reason as
  // Slack: the bot token is encrypted at rest and the Bot API client lives
  // in src/lib, so no tenant secret lands in an edge function. Same
  // never-connected silence rule again: a business with no telegram
  // coworker_connections row records NOTHING here. Mirrors the sixth arm of
  // src/lib/notifications/dispatch.ts, and tests/notifications-deno-parity
  // is what stops the two drifting.
  let telegramConnected = true;
  {
    const { data: tgConn, error: tgConnErr } = await supa
      .from("coworker_connections")
      .select("business_id")
      .eq("business_id", record.business_id)
      .eq("channel", "telegram")
      .maybeSingle();
    if (!tgConnErr) telegramConnected = tgConn !== null;
  }
  if (!telegramConnected) {
    // Not applicable to this business: no row, no delivery attempt.
  } else if (!targets.telegramUrgent || targets.unsubscribed) {
    await recordRow(
      ctx,
      record.business_id,
      "telegram",
      "skipped",
      summary,
      kind,
      basePayload,
      targets.unsubscribed ? "unsubscribed" : "telegram_urgent_disabled"
    );
  } else if (suppressTransports) {
    await recordRow(
      ctx,
      record.business_id,
      "telegram",
      "skipped",
      summary,
      kind,
      basePayload,
      "recent_team_notify"
    );
  } else if (cronSecret && appUrl) {
    try {
      const tgRes = await fetch(`${appUrl}/api/internal/telegram-send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cronSecret}`,
          // CSRF gate: src/proxy.ts allows server-to-server bearer POSTs
          // only when Origin matches NEXT_PUBLIC_APP_URL.
          Origin: appUrl
        },
        body: JSON.stringify({
          businessId: record.business_id,
          summary: phiFree?.summary ?? summary,
          // Always null, and NOT the same field as the Node path's
          // `input.smsBody`. This pipeline builds a notification from a
          // system_logs row, which carries a summary and a payload but no
          // separate body, so there is nothing further to say. Written as a
          // constant rather than a ternary because the ternary previously
          // read `phiFree ? null : null`, which looks like a dropped branch.
          details: null,
          detailsUrl: dashboardUrl
        })
      });
      const tgJson = tgRes.ok
        ? ((await tgRes.json().catch(() => null)) as {
            data?: { ok?: boolean; chatId?: string; reason?: string; detail?: string };
          } | null)
        : null;
      if (tgJson?.data?.ok) {
        await recordRow(ctx, record.business_id, "telegram", "sent", summary, kind, {
          ...basePayload,
          recipient: tgJson.data.chatId ?? "telegram"
        });
      } else if (tgRes.ok) {
        // Structured policy skip (needs reconnect / no target / tier). A
        // NEVER-connected business records nothing (raced a disconnect).
        const tgReason = tgJson?.data?.reason ?? "send_failed";
        if (tgReason !== "not_connected") {
          await recordRow(
            ctx,
            record.business_id,
            "telegram",
            tgReason === "send_failed" ? "failed" : "skipped",
            summary,
            kind,
            basePayload,
            tgJson?.data?.detail ? `${tgReason}:${tgJson.data.detail}` : tgReason
          );
        }
      } else {
        errors.push(`Telegram failed: ${tgRes.status}`);
        await recordRow(
          ctx,
          record.business_id,
          "telegram",
          "failed",
          summary,
          kind,
          basePayload,
          `telegram_bridge_${tgRes.status}`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Telegram error: ${msg}`);
      await recordRow(
        ctx,
        record.business_id,
        "telegram",
        "failed",
        summary,
        kind,
        basePayload,
        msg
      );
    }
  } else {
    await recordRow(
      ctx,
      record.business_id,
      "telegram",
      "skipped",
      summary,
      kind,
      basePayload,
      "telegram_bridge_unconfigured"
    );
  }

  // Microsoft Teams, through /api/internal/teams-send for the same reason
  // as Slack and Telegram: the Azure app secret and the Bot Connector client
  // live in src/lib, so no credential lands in an edge function. Mirrors the
  // seventh arm of src/lib/notifications/dispatch.ts.
  let teamsConnected = true;
  {
    const { data: tmConn, error: tmConnErr } = await supa
      .from("coworker_connections")
      .select("business_id")
      .eq("business_id", record.business_id)
      .eq("channel", "teams")
      .maybeSingle();
    if (!tmConnErr) teamsConnected = tmConn !== null;
  }
  if (!teamsConnected) {
    // Not applicable to this business: no row, no delivery attempt.
  } else if (!targets.teamsUrgent || targets.unsubscribed) {
    await recordRow(
      ctx,
      record.business_id,
      "teams",
      "skipped",
      summary,
      kind,
      basePayload,
      targets.unsubscribed ? "unsubscribed" : "teams_urgent_disabled"
    );
  } else if (suppressTransports) {
    await recordRow(
      ctx,
      record.business_id,
      "teams",
      "skipped",
      summary,
      kind,
      basePayload,
      "recent_team_notify"
    );
  } else if (cronSecret && appUrl) {
    try {
      const tmRes = await fetch(`${appUrl}/api/internal/teams-send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cronSecret}`,
          Origin: appUrl
        },
        body: JSON.stringify({
          businessId: record.business_id,
          summary: phiFree?.summary ?? summary,
          // Always null on this path, and NOT the Node side's
          // `input.smsBody`: this pipeline builds a notification from a
          // system_logs row, which carries a summary and a payload but no
          // separate body.
          details: null,
          detailsUrl: dashboardUrl
        })
      });
      const tmJson = tmRes.ok
        ? ((await tmRes.json().catch(() => null)) as {
            data?: { ok?: boolean; conversationId?: string; reason?: string; detail?: string };
          } | null)
        : null;
      if (tmJson?.data?.ok) {
        await recordRow(ctx, record.business_id, "teams", "sent", summary, kind, {
          ...basePayload,
          recipient: tmJson.data.conversationId ?? "teams"
        });
      } else if (tmRes.ok) {
        const tmReason = tmJson?.data?.reason ?? "send_failed";
        if (tmReason !== "not_connected") {
          await recordRow(
            ctx,
            record.business_id,
            "teams",
            tmReason === "send_failed" ? "failed" : "skipped",
            summary,
            kind,
            basePayload,
            tmJson?.data?.detail ? `${tmReason}:${tmJson.data.detail}` : tmReason
          );
        }
      } else {
        errors.push(`Teams failed: ${tmRes.status}`);
        await recordRow(
          ctx,
          record.business_id,
          "teams",
          "failed",
          summary,
          kind,
          basePayload,
          `teams_bridge_${tmRes.status}`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Teams error: ${msg}`);
      await recordRow(ctx, record.business_id, "teams", "failed", summary, kind, basePayload, msg);
    }
  } else {
    await recordRow(
      ctx,
      record.business_id,
      "teams",
      "skipped",
      summary,
      kind,
      basePayload,
      "teams_bridge_unconfigured"
    );
  }

  // Google Chat, through /api/internal/google-chat-send for the same reason
  // as the three above: the service-account key and the Chat client live in
  // src/lib, so no credential lands in an edge function. Mirrors the eighth
  // arm of src/lib/notifications/dispatch.ts.
  //
  // `.maybeSingle()` is right here and would NOT be on a per-device table:
  // coworker_connections holds at most one row per (business, channel), so
  // there is nothing for it to throw on.
  let googleChatConnected = true;
  {
    const { data: gcConn, error: gcConnErr } = await supa
      .from("coworker_connections")
      .select("business_id")
      .eq("business_id", record.business_id)
      .eq("channel", "google_chat")
      .maybeSingle();
    if (!gcConnErr) googleChatConnected = gcConn !== null;
  }
  if (!googleChatConnected) {
    // Not applicable to this business: no row, no delivery attempt.
  } else if (!targets.googleChatUrgent || targets.unsubscribed) {
    await recordRow(
      ctx,
      record.business_id,
      "google_chat",
      "skipped",
      summary,
      kind,
      basePayload,
      targets.unsubscribed ? "unsubscribed" : "google_chat_urgent_disabled"
    );
  } else if (suppressTransports) {
    await recordRow(
      ctx,
      record.business_id,
      "google_chat",
      "skipped",
      summary,
      kind,
      basePayload,
      "recent_team_notify"
    );
  } else if (cronSecret && appUrl) {
    try {
      const gcRes = await fetch(`${appUrl}/api/internal/google-chat-send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cronSecret}`,
          Origin: appUrl
        },
        body: JSON.stringify({
          businessId: record.business_id,
          summary: phiFree?.summary ?? summary,
          // Always null on this path, and NOT the Node side's
          // `input.smsBody`: this pipeline builds a notification from a
          // system_logs row, which carries a summary and a payload but no
          // separate body.
          details: null,
          detailsUrl: dashboardUrl
        })
      });
      const gcJson = gcRes.ok
        ? ((await gcRes.json().catch(() => null)) as {
            data?: { ok?: boolean; space?: string; reason?: string; detail?: string };
          } | null)
        : null;
      if (gcJson?.data?.ok) {
        await recordRow(ctx, record.business_id, "google_chat", "sent", summary, kind, {
          ...basePayload,
          recipient: gcJson.data.space ?? "google_chat"
        });
      } else if (gcRes.ok) {
        const gcReason = gcJson?.data?.reason ?? "send_failed";
        if (gcReason !== "not_connected") {
          await recordRow(
            ctx,
            record.business_id,
            "google_chat",
            gcReason === "send_failed" ? "failed" : "skipped",
            summary,
            kind,
            basePayload,
            gcJson?.data?.detail ? `${gcReason}:${gcJson.data.detail}` : gcReason
          );
        }
      } else {
        errors.push(`Google Chat failed: ${gcRes.status}`);
        await recordRow(
          ctx,
          record.business_id,
          "google_chat",
          "failed",
          summary,
          kind,
          basePayload,
          `google_chat_bridge_${gcRes.status}`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Google Chat error: ${msg}`);
      await recordRow(
        ctx,
        record.business_id,
        "google_chat",
        "failed",
        summary,
        kind,
        basePayload,
        msg
      );
    }
  } else {
    await recordRow(
      ctx,
      record.business_id,
      "google_chat",
      "skipped",
      summary,
      kind,
      basePayload,
      "google_chat_bridge_unconfigured"
    );
  }

  // 9) Web Push, delegated to the Next.js internal endpoint (VAPID signing is
  // ECDSA P-256 and the payload is aes128gcm, both node:crypto, so no VAPID
  // private key lands in an edge function). Same never-connected silence rule
  // as WhatsApp and Slack. Mirrors the sixth arm of
  // src/lib/notifications/dispatch.ts.
  if (!pushConnected) {
    // Not applicable to this business: no row, no delivery attempt.
  } else if (!targets.pushUrgent || targets.unsubscribed) {
    await recordRow(
      ctx,
      record.business_id,
      "push",
      "skipped",
      summary,
      kind,
      basePayload,
      targets.unsubscribed ? "unsubscribed" : "push_urgent_disabled"
    );
  } else if (suppressTransports) {
    await recordRow(
      ctx,
      record.business_id,
      "push",
      "skipped",
      summary,
      kind,
      basePayload,
      "recent_team_notify"
    );
  } else if (cronSecret && appUrl) {
    // Minted HERE rather than inside recordRow because the service worker
    // posts it back as the click receipt, so it has to travel WITH the push.
    // The row it names is written below with this same id.
    //
    // Without it the edge path still delivers a banner and still records a
    // click, but the receipt binds to NOTHING: markNotificationRead never
    // fires, so the alert stays unread forever, and the click row lands with
    // a null notification_id. That is the read receipt this whole channel was
    // built for, silently degraded on one of the two pipelines.
    const pushNotificationId = crypto.randomUUID();
    try {
      const pushRes = await fetch(`${appUrl}/api/internal/push-send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cronSecret}`,
          // CSRF gate: src/proxy.ts allows server-to-server bearer POSTs only
          // when Origin matches NEXT_PUBLIC_APP_URL.
          Origin: appUrl
        },
        body: JSON.stringify({
          businessId: record.business_id,
          title: "New Coworker",
          // The banner sits on a lock screen, so it takes the phiFree copy on
          // the same terms as every other leg here.
          body: phiFree?.summary ?? summary.replace(/\.+$/, ""),
          // No ctaPath in this pipeline, so send the two inputs and let the
          // bridge resolve the destination with notificationLink, the same
          // function the Node dispatcher and the dashboard's notification
          // list use. Hardcoding "/dashboard" here dropped the owner on a
          // generic page to go hunting for whatever the alert was about.
          //
          // EXCEPT under HIPAA, where the deep link is itself a disclosure: a
          // derived path like /dashboard/customers/%2B15551234567 carries a
          // patient identifier, and this payload goes to a third-party push
          // vendor. Pinned to the plain dashboard, the same override the Node
          // dispatcher applies. `payload` is withheld entirely rather than
          // sent alongside a pinned url, because it is the thing that carries
          // the identifier.
          ...(phiFree ? { url: "/dashboard" } : { kind, payload: basePayload }),
          notificationId: pushNotificationId
        })
      });
      const pushJson = pushRes.ok
        ? ((await pushRes.json().catch(() => null)) as {
            data?: { ok?: boolean; sent?: number; revoked?: number; reason?: string; detail?: string };
          } | null)
        : null;
      if (pushJson?.data?.ok) {
        await recordRow(
          ctx,
          record.business_id,
          "push",
          "sent",
          summary,
          kind,
          {
            ...basePayload,
            recipient: `${pushJson.data.sent ?? 0} device(s)`,
            devices_sent: pushJson.data.sent ?? 0,
            devices_revoked: pushJson.data.revoked ?? 0
          },
          undefined,
          pushNotificationId
        );
      } else if (pushRes.ok) {
        // Structured policy skip. A NEVER-subscribed business records nothing
        // (raced an unsubscribe since the check above).
        const pushReason = pushJson?.data?.reason ?? "send_failed";
        if (pushReason !== "not_connected") {
          await recordRow(
            ctx,
            record.business_id,
            "push",
            pushReason === "send_failed" ? "failed" : "skipped",
            summary,
            kind,
            basePayload,
            pushJson?.data?.detail
              ? `push_${pushReason}:${pushJson.data.detail}`
              : `push_${pushReason}`,
            pushNotificationId
          );
        }
      } else {
        errors.push(`Push failed: ${pushRes.status}`);
        await recordRow(
          ctx,
          record.business_id,
          "push",
          "failed",
          summary,
          kind,
          basePayload,
          `push_bridge_${pushRes.status}`,
          pushNotificationId
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Push error: ${msg}`);
      await recordRow(
        ctx,
        record.business_id,
        "push",
        "failed",
        summary,
        kind,
        basePayload,
        msg,
        pushNotificationId
      );
    }
  } else {
    await recordRow(
      ctx,
      record.business_id,
      "push",
      "skipped",
      summary,
      kind,
      basePayload,
      "push_bridge_unconfigured"
    );
  }

  // Raise the admin alarm for anything that failed, AFTER every leg has had
  // its turn, because "did this reach anybody" can only be answered by
  // looking at all of them together.
  await reportFailedChannels(ctx, record.business_id, kind, summary);

  return new Response(
    JSON.stringify({ ok: errors.length === 0, errors }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
