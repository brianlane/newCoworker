/**
 * Telnyx Messaging inbound → verify, dedupe, INSERT sms_inbound_jobs (§10).
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { header, verifyTelnyxWebhook } from "../_shared/telnyx_webhook.ts";
import { telnyxMessagingPhoneString } from "../_shared/telnyx_messaging_payload.ts";
import { normalizeE164 } from "../_shared/normalize_e164.ts";

const MAX_BODY = 256 * 1024;

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const publicKey = Deno.env.get("TELNYX_PUBLIC_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!publicKey || !supabaseUrl || !serviceKey) {
    return new Response("Server misconfigured", { status: 500 });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) {
    return new Response("Payload too large", { status: 413 });
  }

  const v = await verifyTelnyxWebhook(
    rawBody,
    header(req, "telnyx-signature-ed25519"),
    header(req, "telnyx-timestamp"),
    publicKey
  );
  if (!v.ok) {
    return new Response("Forbidden", { status: 403 });
  }

  let envelope: { data?: { id?: string; event_type?: string; payload?: Record<string, unknown> } };
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const data = envelope.data;
  const eventId = data?.id;
  const eventType = data?.event_type ?? "";
  if (!eventId) {
    return new Response("Missing event id", { status: 400 });
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: isNew } = await supabase.rpc("telnyx_webhook_try_dedupe", {
    p_event_id: eventId,
    p_event_type: eventType
  });
  if (isNew === false) {
    return new Response(JSON.stringify({ ok: true, duplicate: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (eventType !== "message.received") {
    return new Response(JSON.stringify({ ok: true, skipped: eventType }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const payload = (data?.payload ?? {}) as Record<string, unknown>;
  const to = normalizeE164(telnyxMessagingPhoneString(payload, "to"));

  if (!to) {
    return new Response(JSON.stringify({ ok: true, skip: "no_to" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const { data: route } = await supabase
    .from("telnyx_voice_routes")
    .select("business_id")
    .eq("to_e164", to)
    .maybeSingle();

  const businessId = route?.business_id as string | undefined;
  if (!businessId) {
    return new Response(JSON.stringify({ ok: true, skip: "unrouted" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const { error } = await supabase.from("sms_inbound_jobs").insert({
    business_id: businessId,
    telnyx_event_id: eventId,
    payload: envelope as unknown as Record<string, unknown>,
    status: "pending",
    outbound_idempotency_key: crypto.randomUUID()
  });

  if (error) {
    console.error("sms queue insert", error);
    return new Response("Queue error", { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, enqueued: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});
