/**
 * Telnyx Messaging inbound → verify, at-least-once webhook handling, INSERT sms_inbound_jobs (§10).
 * STOP/HELP keywords: auto-reply when TELNYX_API_KEY + messaging env are set (carrier compliance).
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { header, verifyTelnyxWebhook } from "../_shared/telnyx_webhook.ts";
import { telnyxMessagingPhoneString } from "../_shared/telnyx_messaging_payload.ts";
import { normalizeE164 } from "../_shared/normalize_e164.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import {
  inboundSmsBody,
  isHelpKeyword,
  isStartKeyword,
  isStopKeyword,
  telnyxSendSms
} from "../_shared/telnyx_sms_compliance.ts";
import {
  readTelnyxWebhookRateLimits,
  telnyxWebhookClientIp,
  telnyxWebhookRateAllow
} from "../_shared/telnyx_edge_guard.ts";

const MAX_BODY = 256 * 1024;

const HELP_REPLY_TEXT =
  "New Coworker: For help, use your business dashboard or contact support. Msg&data rates may apply. Reply STOP to opt out.";
const STOP_REPLY_TEXT =
  "You're opted out of New Coworker marketing SMS for this number. You may still get transactional messages.";
const START_REPLY_TEXT =
  "You're subscribed to New Coworker SMS for this number. Reply STOP to opt out. Msg&data rates may apply.";

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const publicKey = Deno.env.get("TELNYX_PUBLIC_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const telnyxApiKey = Deno.env.get("TELNYX_API_KEY") ?? "";
  const messagingProfileId = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") ?? "";
  const smsFromE164 = Deno.env.get("TELNYX_SMS_FROM_E164") ?? "";

  if (!publicKey || !supabaseUrl || !serviceKey) {
    return new Response("Server misconfigured", { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) {
    await telemetryRecord(supabase, "edge_webhook_rejected", {
      reason: "size",
      route: "telnyx_sms_inbound"
    });
    return new Response("Payload too large", { status: 413 });
  }

  const clientIp = telnyxWebhookClientIp(req);
  const rate = await telnyxWebhookRateAllow(
    supabase,
    clientIp,
    "telnyx_sms_inbound",
    readTelnyxWebhookRateLimits((k) => Deno.env.get(k))
  );
  if (!rate.ok) {
    await telemetryRecord(supabase, "edge_webhook_rejected", {
      reason: "rate",
      route: "telnyx_sms_inbound",
      detail: rate.raw
    });
    return new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
      status: 429,
      headers: { "Content-Type": "application/json" }
    });
  }

  const v = await verifyTelnyxWebhook(
    rawBody,
    header(req, "telnyx-signature-ed25519"),
    header(req, "telnyx-timestamp"),
    publicKey
  );
  if (!v.ok) {
    await telemetryRecord(supabase, "telnyx_webhook_signature_reject", {
      class: v.reason,
      route: "telnyx_sms_inbound"
    });
    return new Response(JSON.stringify({ ok: false, error: "bad_signature" }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
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

  const { data: beginRaw, error: beginErr } = await supabase.rpc("telnyx_webhook_try_begin", {
    p_event_id: eventId,
    p_event_type: eventType
  });
  if (beginErr) {
    console.error("telnyx_webhook_try_begin", beginErr);
    return new Response("Webhook begin error", { status: 500 });
  }
  const begin = beginRaw as { status?: string } | null;
  if (begin?.status === "done") {
    return new Response(
      JSON.stringify({ ok: true, duplicate: true, webhook_complete: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  if (begin?.status === "busy") {
    await telemetryRecord(supabase, "edge_webhook_rejected", {
      reason: "concurrent_claim",
      route: "telnyx_sms_inbound",
      event_id: eventId
    });
    return new Response(JSON.stringify({ ok: false, error: "event_in_flight" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (begin?.status !== "work") {
    console.error("telnyx_webhook_try_begin unexpected", beginRaw);
    return new Response("Webhook begin state error", { status: 500 });
  }

  const response = await (async (): Promise<Response> => {
    if (eventType !== "message.received") {
      return new Response(JSON.stringify({ ok: true, skipped: eventType }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const payload = (data?.payload ?? {}) as Record<string, unknown>;
    const to = normalizeE164(telnyxMessagingPhoneString(payload, "to"));
    const from = normalizeE164(telnyxMessagingPhoneString(payload, "from"));

    if (!to) {
      return new Response(JSON.stringify({ ok: true, skip: "no_to" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const bodyNorm = inboundSmsBody(payload).trim().toUpperCase();
    const canAutoReply = Boolean(telnyxApiKey && messagingProfileId && smsFromE164 && from);

    if (isStopKeyword(bodyNorm)) {
      if (canAutoReply) {
        const send = await telnyxSendSms({
          apiKey: telnyxApiKey,
          messagingProfileId,
          fromE164: smsFromE164,
          toE164: from!,
          text: STOP_REPLY_TEXT
        });
        if (!send.ok) {
          console.error("compliance STOP reply", send.status, send.body.slice(0, 300));
        }
      } else {
        console.warn("telnyx-sms-inbound: STOP without TELNYX_API_KEY/Messaging env; no auto-reply");
      }
      await telemetryRecord(supabase, "sms_inbound_stop_keyword", { to, event_id: eventId });
      return new Response(JSON.stringify({ ok: true, compliance: "stop" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (isHelpKeyword(bodyNorm)) {
      if (canAutoReply) {
        const send = await telnyxSendSms({
          apiKey: telnyxApiKey,
          messagingProfileId,
          fromE164: smsFromE164,
          toE164: from!,
          text: HELP_REPLY_TEXT
        });
        if (!send.ok) {
          console.error("compliance HELP reply", send.status, send.body.slice(0, 300));
        }
      } else {
        console.warn("telnyx-sms-inbound: HELP without TELNYX_API_KEY/Messaging env; no auto-reply");
      }
      await telemetryRecord(supabase, "sms_inbound_help_keyword", { to, event_id: eventId });
      return new Response(JSON.stringify({ ok: true, compliance: "help" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (isStartKeyword(bodyNorm)) {
      if (canAutoReply) {
        const send = await telnyxSendSms({
          apiKey: telnyxApiKey,
          messagingProfileId,
          fromE164: smsFromE164,
          toE164: from!,
          text: START_REPLY_TEXT
        });
        if (!send.ok) {
          console.error("compliance START reply", send.status, send.body.slice(0, 300));
        }
      } else {
        console.warn("telnyx-sms-inbound: START without TELNYX_API_KEY/Messaging env; no auto-reply");
      }
      await telemetryRecord(supabase, "sms_inbound_start_keyword", { to, event_id: eventId });
      return new Response(JSON.stringify({ ok: true, compliance: "start" }), {
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
      if ((error as { code?: string }).code === "23505") {
        return new Response(JSON.stringify({ ok: true, duplicate_job: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      console.error("sms queue insert", error);
      return new Response("Queue error", { status: 500 });
    }

    await telemetryRecord(supabase, "sms_inbound_enqueued", { business_id: businessId, event_id: eventId });

    return new Response(JSON.stringify({ ok: true, enqueued: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  })();

  if (response.ok) {
    const { error: mErr } = await supabase.rpc("telnyx_webhook_mark_complete", { p_event_id: eventId });
    if (mErr) console.error("telnyx_webhook_mark_complete", mErr);
  }
  return response;
});
