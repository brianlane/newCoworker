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
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { buildBrandedEmailHtml } from "../_shared/branded_email_html.ts";
import { normalizeE164 } from "../_shared/normalize_e164.ts";
import {
  meterOperationalSms,
  releaseOperationalSms
} from "../_shared/sms_operational_meter.ts";

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

type DeliveryChannel = "sms" | "email" | "dashboard" | "whatsapp";
type DeliveryStatus = "queued" | "sent" | "failed" | "skipped";

type ResolvedTargets = {
  email: string | null;
  phone: string | null;
  smsUrgent: boolean;
  whatsappUrgent: boolean;
  emailUrgent: boolean;
  dashboardAlerts: boolean;
  unsubscribed: boolean;
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
// Plain `?bid=<businessId>` parameter — no HMAC. UUID v4 is unguessable and
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

async function resolveTargets(supa: SupaClient, businessId: string): Promise<ResolvedTargets> {
  const fallbackEmail = (Deno.env.get("ADMIN_EMAIL") ?? "").trim() || null;
  const fallbackPhone = normalizeE164(Deno.env.get("TELNYX_OWNER_PHONE") ?? "");
  let prefsEmail: string | null = null;
  let prefsPhone: string | null = null;
  let smsUrgent = true;
  let whatsappUrgent = true;
  let emailUrgent = true;
  let dashboardAlerts = true;
  let unsubscribed = false;
  let ownerEmail: string | null = null;

  const { data: prefs } = await supa
    .from("notification_preferences")
    .select(
      "alert_email, phone_number, sms_urgent, whatsapp_urgent, email_urgent, dashboard_alerts, unsubscribed_at"
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
    emailUrgent = Boolean(prefs.email_urgent);
    dashboardAlerts = Boolean(prefs.dashboard_alerts);
    unsubscribed = Boolean(prefs.unsubscribed_at);
  }

  const { data: business } = await supa
    .from("businesses")
    .select("owner_email")
    .eq("id", businessId)
    .maybeSingle();
  if (business) {
    ownerEmail = ((business.owner_email as string | null) ?? "").trim() || null;
  }

  return {
    email: prefsEmail ?? ownerEmail ?? fallbackEmail,
    phone: prefsPhone ?? fallbackPhone,
    smsUrgent,
    whatsappUrgent,
    emailUrgent,
    dashboardAlerts,
    unsubscribed
  };
}

async function recordRow(
  supa: SupaClient,
  businessId: string,
  channel: DeliveryChannel,
  status: DeliveryStatus,
  summary: string,
  kind: string,
  payload: Record<string, unknown>,
  reason?: string
): Promise<void> {
  const id = crypto.randomUUID();
  const { error } = await supa.from("notifications").insert({
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
 * merges sms_inbound_jobs + sms_outbound_log — see src/lib/db/sms-history.ts).
 * Without this the only record of "the owner was paged" lived in Telnyx
 * (observed live: the Jul 17 2026 needs-human page was sent but invisible).
 * A logging failure must never fail the alert that already went out — same
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
  // accepted the alert — a thrown insert (network blip) would otherwise
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
  // "URGENT <task_type>" headline — silence (blocked texts / degraded chat /
  // refused callers) must never be the only signal a cap was hit.
  const missedToday = Number(record.log_payload?.missed_calls_today ?? 0);
  // Needs-human escalations (see _shared/needs_human.ts): the texting
  // coworker hit something it couldn't handle and handed the conversation
  // to the owner — say who and why, not "URGENT sms_needs_human".
  const needsHumanLabel = String(record.log_payload?.contact_label ?? "a texter");
  const needsHumanReason = String(record.log_payload?.reason ?? "").trim();
  // AiFlow failure alerts (opt-in, _shared/aiflow_failure_alert.ts): a
  // lead-intake automation died — say which lead and why, not a raw task_type.
  const aiflowLeadLabel = String(record.log_payload?.lead_label ?? "a lead");
  const aiflowReason = String(record.log_payload?.reason ?? "").trim();
  // Customer reply alerts (opt-in, _shared/customer_reply_alert.ts): a
  // client texted back — say who and what they said (KYP, Jul 20 2026).
  const replyLabel = String(record.log_payload?.contact_label ?? "A contact");
  const replyPreview = String(record.log_payload?.inbound_preview ?? "").trim();
  const summary =
    record.task_type === "sms_cap_reached"
      ? "Monthly SMS limit reached; outbound texting is paused. Buy an SMS pack from Billing to resume."
      : record.task_type === "chat_spend_cap_reached"
        ? "AI chat budget reached; replies switched to the slower local model. Buy a Gemini pack from Billing to restore."
        : record.task_type === "missed_call_spike"
          ? `${missedToday || "Several"} callers were turned away today (line busy or out of voice minutes). Check Analytics on your dashboard; a plan upgrade or minutes top-up stops the misses.`
          : record.task_type === "sms_needs_human"
            ? `Your texting coworker needs you to take over with ${needsHumanLabel}${needsHumanReason ? ` — ${needsHumanReason}` : ""}. Reply from Messages on your dashboard.`.slice(0, 320)
            : record.task_type === "aiflow_run_failed"
              ? `An AiFlow stopped while handling ${aiflowLeadLabel}${aiflowReason ? ` — ${aiflowReason}` : ""}. Follow up with them yourself and check the flow's run history on your dashboard.`.slice(0, 320)
              : record.task_type === "sms_customer_reply"
                ? `${replyLabel} texted back${replyPreview ? `: "${replyPreview}"` : ""}. Reply from Messages on your dashboard.`.slice(0, 320)
                : `URGENT ${record.task_type}`;
  const kind = "urgent_alert";
  // Strip trailing slash so dashboardUrl never ends up as
  // `https://example.com//dashboard` if the env var was set with one.
  const appUrl = (Deno.env.get("NEXT_PUBLIC_APP_URL") ?? "https://www.newcoworker.com").replace(
    /\/$/,
    ""
  );
  const dashboardUrl = `${appUrl}/dashboard`;

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supa = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null;
  if (!supa || !record.business_id) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing_supabase_or_business_id" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const targets = await resolveTargets(supa, record.business_id);
  const basePayload: Record<string, unknown> = {
    summary,
    logId: record.id,
    taskType: record.task_type,
    // Needs-human escalations and customer-reply alerts stamp the contact so
    // their per-contact dedupe/coalesce lookups (payload->>contactE164) can
    // find prior pages — see _shared/needs_human.ts and
    // _shared/customer_reply_alert.ts.
    ...((record.task_type === "sms_needs_human" || record.task_type === "sms_customer_reply") &&
    record.log_payload?.contact_e164
      ? { contactE164: String(record.log_payload.contact_e164) }
      : {}),
    // AiFlow failure alerts stamp the run so the alert module's per-run
    // dedupe (payload->>runId) can find prior delivered pages — see
    // _shared/aiflow_failure_alert.ts.
    ...(record.task_type === "aiflow_run_failed" && record.log_payload?.run_id
      ? { runId: String(record.log_payload.run_id) }
      : {})
  };
  const errors: string[] = [];

  // 1) Dashboard channel
  if (targets.dashboardAlerts && !targets.unsubscribed) {
    await recordRow(supa, record.business_id, "dashboard", "sent", summary, kind, basePayload);
  } else {
    await recordRow(
      supa,
      record.business_id,
      "dashboard",
      "skipped",
      summary,
      kind,
      basePayload,
      targets.unsubscribed ? "unsubscribed" : "dashboard_alerts_disabled"
    );
  }

  // 2) SMS channel via Telnyx — with per-business messaging profile / from override
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

  const telnyxKey = Deno.env.get("TELNYX_API_KEY");
  if (!targets.phone) {
    await recordRow(
      supa,
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
      supa,
      record.business_id,
      "sms",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.phone },
      targets.unsubscribed ? "unsubscribed" : "sms_urgent_disabled"
    );
  } else if (telnyxKey && telnyxProfile) {
    // Owner alerts are METERED against the tenant's monthly pool like all
    // traffic (Jul 14 2026 policy: nothing is exempt) but never REFUSED —
    // the "you hit your SMS cap" alert must outrun the cap it reports.
    // Declared OUTSIDE the try so the catch can release the counted slot
    // when the fetch itself throws (network error — nothing left Telnyx).
    const smsMeter = await meterOperationalSms(supa, record.business_id);
    // Slot lifecycle guard: set once the counted slot is SETTLED — either
    // kept (Telnyx accepted the alert) or already released (Telnyx
    // rejected it). A later throw in the same try (recordRow, error-body
    // read) re-enters the catch, which must neither refund a delivered
    // alert nor release the same slot twice.
    let smsMeterSettled = false;
    try {
      const smsText = `New Coworker Alert: ${summary}. Details: ${dashboardUrl}`;
      const body: Record<string, string> = {
        to: targets.phone,
        text: smsText,
        messaging_profile_id: telnyxProfile
      };
      if (telnyxFrom) body.from = telnyxFrom;
      const smsRes = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${telnyxKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      if (!smsRes.ok) {
        // The alert never left Telnyx — give the counted slot back.
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
          supa,
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
          supa,
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
      // threw — nothing left Telnyx). A delivered alert stays counted, and
      // an already-released slot is never released twice.
      if (!smsMeterSettled) {
        await releaseOperationalSms(supa, record.business_id, smsMeter);
      }
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`SMS error: ${msg}`);
      await recordRow(
        supa,
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
      supa,
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
      supa,
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
      supa,
      record.business_id,
      "email",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.email },
      targets.unsubscribed ? "unsubscribed" : "email_urgent_disabled"
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
      const subject = `Urgent: ${summary}`;
      const baseText = `Your AI Coworker flagged an urgent event.\n\nSummary: ${summary}\nBusiness ID: ${record.business_id}\n\nView details: ${dashboardUrl}`;
      const text = `${baseText}\n\n---\nDon't want these alerts? Unsubscribe with one click: ${unsubscribeUrl}`;
      const html = buildBrandedEmailHtml({
        siteUrl: appUrl,
        documentTitle: subject,
        heading: subject,
        bodyBlocks: [
          { kind: "text", text: "Your AI Coworker flagged an urgent event." },
          { kind: "text", text: `Summary: ${summary}` },
          { kind: "text", text: `Business ID: ${record.business_id}` }
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
          supa,
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
          supa,
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
        supa,
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
      supa,
      record.business_id,
      "email",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.email },
      "resend_unconfigured"
    );
  }

  // 4) WhatsApp channel — delegated to the Next.js internal deliver
  // endpoint (Cloud API client, tenant token decryption, 24h-window +
  // template routing live there). Fully additive: no connected WhatsApp
  // integration comes back as a structured not_connected skip.
  const cronSecret = (Deno.env.get("INTERNAL_CRON_SECRET") ?? "").trim();
  if (!targets.phone) {
    await recordRow(
      supa,
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
      supa,
      record.business_id,
      "whatsapp",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.phone },
      targets.unsubscribed ? "unsubscribed" : "whatsapp_urgent_disabled"
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
          text: `New Coworker Alert: ${summary}. Details: ${dashboardUrl}`,
          audience: "owner"
        })
      });
      const waJson = waRes.ok
        ? ((await waRes.json().catch(() => null)) as {
            data?: { ok?: boolean; via?: string; reason?: string };
          } | null)
        : null;
      if (waJson?.data?.ok) {
        await recordRow(
          supa,
          record.business_id,
          "whatsapp",
          "sent",
          summary,
          kind,
          { ...basePayload, recipient: targets.phone, via: waJson.data.via ?? "text" }
        );
      } else if (waRes.ok) {
        // Structured policy skip (not connected / template in review).
        await recordRow(
          supa,
          record.business_id,
          "whatsapp",
          waJson?.data?.reason === "send_failed" ? "failed" : "skipped",
          summary,
          kind,
          { ...basePayload, recipient: targets.phone },
          waJson?.data?.reason ?? "send_failed"
        );
      } else {
        errors.push(`WhatsApp failed: ${waRes.status}`);
        await recordRow(
          supa,
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
        supa,
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
      supa,
      record.business_id,
      "whatsapp",
      "skipped",
      summary,
      kind,
      { ...basePayload, recipient: targets.phone },
      "whatsapp_bridge_unconfigured"
    );
  }

  return new Response(
    JSON.stringify({ ok: errors.length === 0, errors }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
