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
  let telnyxProfile = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") ?? "";
  let telnyxFrom = Deno.env.get("TELNYX_SMS_FROM_E164") ?? "";
  const ownerPhone = Deno.env.get("TELNYX_OWNER_PHONE") ?? Deno.env.get("TWILIO_OWNER_PHONE");

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supa =
    supabaseUrl && serviceKey && record.business_id
      ? createClient(supabaseUrl, serviceKey)
      : null;

  if (supa) {
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
  }

  if (telnyxKey && telnyxProfile && ownerPhone) {
    if (!supa) {
      errors.push("SMS skipped: Supabase not configured for quota enforcement");
    } else {
      const { data: resRaw, error: resErr } = await supa.rpc("try_reserve_sms_outbound_slot", {
        p_business_id: record.business_id
      });
      if (resErr) {
        errors.push(`SMS quota reserve failed: ${resErr.message}`);
      } else {
        const res = resRaw as { ok?: boolean } | null;
        if (res?.ok !== true) {
          errors.push("SMS monthly quota exceeded");
        } else {
          let released = false;
          const release = async (): Promise<void> => {
            if (released) return;
            released = true;
            const { error: relErr } = await supa.rpc("release_sms_outbound_slot", {
              p_business_id: record.business_id
            });
            if (relErr) {
              console.error("notifications: release_sms_outbound_slot failed", relErr.message);
            }
          };
          try {
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
            if (!smsRes.ok) {
              await release();
              errors.push(`SMS failed: ${smsRes.status}`);
            }
          } catch (e) {
            await release();
            errors.push(`SMS error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
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
