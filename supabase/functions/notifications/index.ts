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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

type DeliveryChannel = "sms" | "email" | "dashboard";
type DeliveryStatus = "queued" | "sent" | "failed" | "skipped";

type ResolvedTargets = {
  email: string | null;
  phone: string | null;
  smsUrgent: boolean;
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
  return `${appUrl.replace(/\/$/, "")}/api/notifications/unsubscribe?bid=${encodeURIComponent(businessId)}`;
}

type SupaClient = ReturnType<typeof createClient>;

async function resolveTargets(supa: SupaClient, businessId: string): Promise<ResolvedTargets> {
  const fallbackEmail = (Deno.env.get("ADMIN_EMAIL") ?? "").trim() || null;
  const fallbackPhone = (Deno.env.get("TELNYX_OWNER_PHONE") ?? "").trim() || null;
  let prefsEmail: string | null = null;
  let prefsPhone: string | null = null;
  let smsUrgent = true;
  let emailUrgent = true;
  let dashboardAlerts = true;
  let unsubscribed = false;
  let ownerEmail: string | null = null;

  const { data: prefs } = await supa
    .from("notification_preferences")
    .select(
      "alert_email, phone_number, sms_urgent, email_urgent, dashboard_alerts, unsubscribed_at"
    )
    .eq("business_id", businessId)
    .maybeSingle();

  if (prefs) {
    prefsEmail = ((prefs.alert_email as string | null) ?? "").trim() || null;
    prefsPhone = ((prefs.phone_number as string | null) ?? "").trim() || null;
    smsUrgent = Boolean(prefs.sms_urgent);
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

  const summary = `URGENT ${record.task_type}`;
  const kind = "urgent_alert";
  const appUrl = Deno.env.get("NEXT_PUBLIC_APP_URL") ?? "https://www.newcoworker.com";
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
    taskType: record.task_type
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
    try {
      // Platform-initiated owner alert (same class as /api/rowboat urgent SMS): not metered against
      // the business monthly pool.
      const body: Record<string, string> = {
        to: targets.phone,
        text: `New Coworker Alert: ${summary}. Details: ${dashboardUrl}`,
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
      if (smsRes.ok) {
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
      const baseText = `Your AI Coworker flagged an urgent event.\n\nSummary: ${summary}\nBusiness ID: ${record.business_id}\n\nView details: ${dashboardUrl}`;
      const text = `${baseText}\n\n---\nDon't want these alerts? Unsubscribe with one click: ${unsubscribeUrl}`;
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers,
        body: JSON.stringify({
          from:
            Deno.env.get("MAILER_EMAIL") ?? "New Coworker <contact@newcoworker.com>",
          to: targets.email,
          reply_to: Deno.env.get("CONTACT_EMAIL") ?? undefined,
          subject: `Urgent: ${summary}`,
          text,
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

  return new Response(
    JSON.stringify({ ok: errors.length === 0, errors }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
