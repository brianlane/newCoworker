// Supabase Edge Function: notifications
// Triggered via Supabase Database Webhook on coworker_logs INSERT
// where status = 'urgent_alert'
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

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

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
    return new Response(JSON.stringify({ skipped: true, reason: "provisioning" }), { status: 200 });
  }
  if (record.status !== "urgent_alert") {
    return new Response(JSON.stringify({ skipped: true }), { status: 200 });
  }

  const summary = `URGENT ${record.task_type}`;
  const appUrl = Deno.env.get("NEXT_PUBLIC_APP_URL") ?? "https://www.newcoworker.com";
  const dashboardUrl = `${appUrl}/dashboard`;

  const errors: string[] = [];

  const telnyxKey = Deno.env.get("TELNYX_API_KEY");
  const telnyxProfile = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID");
  const telnyxFrom = Deno.env.get("TELNYX_SMS_FROM_E164");
  const ownerPhone = Deno.env.get("TELNYX_OWNER_PHONE") ?? Deno.env.get("TWILIO_OWNER_PHONE");

  if (telnyxKey && telnyxProfile && ownerPhone) {
    const body: Record<string, string> = {
      to: ownerPhone,
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
    if (!smsRes.ok) errors.push(`SMS failed: ${smsRes.status}`);
  }

  // Send email via Resend
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const ownerEmail = Deno.env.get("ADMIN_EMAIL");

  if (resendKey && ownerEmail) {
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: Deno.env.get("MAILER_EMAIL") ?? "New Coworker <contact@newcoworker.com>",
        to: ownerEmail,
        reply_to: Deno.env.get("CONTACT_EMAIL") ?? undefined,
        subject: `Urgent: ${summary}`,
        text: `Your AI Coworker flagged an urgent event.\n\nSummary: ${summary}\nBusiness ID: ${record.business_id}\n\nView details: ${dashboardUrl}`
      })
    });
    if (!emailRes.ok) errors.push(`Email failed: ${emailRes.status}`);
  }

  return new Response(
    JSON.stringify({ ok: errors.length === 0, errors }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
