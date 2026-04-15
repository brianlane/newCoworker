/**
 * Telnyx Programmable Voice: call.initiated → verify, dedupe, reserve, answer with Gemini bridge stream URL.
 *
 * Secrets: TELNYX_API_KEY, TELNYX_PUBLIC_KEY, STREAM_URL_SIGNING_SECRET,
 *          SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *          BRIDGE_MEDIA_WSS_ORIGIN (optional fallback when route has no origin)
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { header, verifyTelnyxWebhook } from "../_shared/telnyx_webhook.ts";
import { signStreamUrlMac, type StreamPayloadV1 } from "../_shared/stream_url.ts";
import { resolveEnterpriseVoiceReservation } from "../_shared/enterprise_limits.ts";
import {
  VOICE_MSG_BRIDGE_DEGRADED,
  VOICE_MSG_QUOTA_EXHAUSTED,
  VOICE_MSG_SYSTEM_ERROR,
  VOICE_MSG_UNCONFIGURED_NUMBER
} from "../_shared/voice_messages.ts";
import { normalizeE164 } from "../_shared/normalize_e164.ts";

const MAX_BODY = 256 * 1024;
const HANDLER_MS = 8000;

function tierCapSeconds(tier: string, enterpriseLimitsRaw: unknown): number {
  if (tier === "enterprise") {
    return resolveEnterpriseVoiceReservation(enterpriseLimitsRaw).tierCapSeconds;
  }
  if (tier === "standard") return 15000;
  return 600;
}

function maxConcurrent(tier: string, enterpriseLimitsRaw: unknown): number {
  if (tier === "enterprise") {
    return resolveEnterpriseVoiceReservation(enterpriseLimitsRaw).maxConcurrent;
  }
  if (tier === "standard") return 3;
  return 1;
}

async function telnyxAnswerPlain(apiKey: string, callControlId: string): Promise<Response> {
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/answer`;
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });
}

async function answerThenSpeak(apiKey: string, callControlId: string, text: string): Promise<void> {
  const ans = await telnyxAnswerPlain(apiKey, callControlId);
  if (!ans.ok) {
    console.error("answer plain failed", callControlId, ans.status, await ans.text());
    return;
  }
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/speak`;
  const sp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ payload: text, voice: "female", language: "en-US" })
  });
  if (!sp.ok) {
    console.error("speak failed", callControlId, sp.status, await sp.text());
  }
}

/** Reject without answering so carrier/PBX can apply busy treatment (e.g. voicemail). */
async function rejectIncomingCall(
  apiKey: string,
  callControlId: string,
  cause: "USER_BUSY" | "CALL_REJECTED" = "USER_BUSY"
): Promise<void> {
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/reject`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ cause })
  });
  if (!res.ok) {
    console.error("reject failed", callControlId, res.status, await res.text());
  }
}

async function telnyxAnswerStream(apiKey: string, callControlId: string, streamUrl: string): Promise<Response> {
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/answer`;
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      stream_url: streamUrl,
      stream_track: "both_tracks",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "L16",
      stream_sampling_rate: 16000
    })
  });
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const deadline = Date.now() + HANDLER_MS;
  const publicKey = Deno.env.get("TELNYX_PUBLIC_KEY") ?? "";
  const apiKey = Deno.env.get("TELNYX_API_KEY") ?? "";
  const streamSecret = Deno.env.get("STREAM_URL_SIGNING_SECRET") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const defaultBridgeOrigin = Deno.env.get("BRIDGE_MEDIA_WSS_ORIGIN") ?? "";

  if (!publicKey || !apiKey || !streamSecret || !supabaseUrl || !serviceKey) {
    console.error("telnyx-voice-inbound: missing env");
    return new Response("Server misconfigured", { status: 500 });
  }

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) {
    return new Response("Payload too large", { status: 413 });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) {
    return new Response("Payload too large", { status: 413 });
  }

  const sig = header(req, "telnyx-signature-ed25519");
  const ts = header(req, "telnyx-timestamp");
  const v = await verifyTelnyxWebhook(rawBody, sig, ts, publicKey);
  if (!v.ok) {
    return new Response("Forbidden", { status: 403 });
  }

  let envelope: {
    data?: {
      id?: string;
      event_type?: string;
      payload?: Record<string, unknown>;
    };
  };
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
  const { data: isNew, error: dedupeErr } = await supabase.rpc("telnyx_webhook_try_dedupe", {
    p_event_id: eventId,
    p_event_type: eventType
  });
  if (dedupeErr) {
    console.error("dedupe", dedupeErr);
    return new Response("Dedupe error", { status: 500 });
  }
  if (isNew === false) {
    return new Response(JSON.stringify({ ok: true, duplicate: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (eventType !== "call.initiated") {
    return new Response(JSON.stringify({ ok: true, skipped: eventType }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const payload = data?.payload ?? {};
  const callControlId = String(payload["call_control_id"] ?? "");
  const toRaw = (payload["to"] ?? payload["To"]) as string | undefined;
  const toE164 = normalizeE164(toRaw);
  if (!callControlId || !toE164) {
    return new Response("Missing call fields", { status: 200 });
  }

  const { data: routeRow, error: routeErr } = await supabase
    .from("telnyx_voice_routes")
    .select("business_id, media_wss_origin, media_path")
    .eq("to_e164", toE164)
    .maybeSingle();

  if (routeErr) {
    console.error("route", routeErr);
    return new Response("DB error", { status: 500 });
  }

  if (!routeRow?.business_id) {
    await answerThenSpeak(apiKey, callControlId, VOICE_MSG_UNCONFIGURED_NUMBER);
    return new Response(JSON.stringify({ ok: true, path: "unconfigured" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const businessId = routeRow.business_id as string;

  const { data: biz, error: bizErr } = await supabase
    .from("businesses")
    .select("tier, enterprise_limits")
    .eq("id", businessId)
    .single();
  if (bizErr || !biz) {
    console.error("business", bizErr);
    await answerThenSpeak(apiKey, callControlId, VOICE_MSG_SYSTEM_ERROR);
    return new Response(JSON.stringify({ ok: true, path: "no_business" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const tier = String(biz.tier ?? "starter");
  const entRaw = tier === "enterprise" ? biz.enterprise_limits : null;
  const cap = tierCapSeconds(tier, entRaw);
  const concurrent = maxConcurrent(tier, entRaw);

  const { data: sub, error: subErr } = await supabase
    .from("subscriptions")
    .select("stripe_current_period_start")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (subErr) {
    console.error("subscription", subErr);
    await answerThenSpeak(apiKey, callControlId, VOICE_MSG_SYSTEM_ERROR);
    return new Response(JSON.stringify({ ok: true, path: "sub_db_error" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const periodStart = sub?.stripe_current_period_start
    ? new Date(sub.stripe_current_period_start as string).toISOString()
    : new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";

  const { data: reserveResult, error: resErr } = await supabase.rpc("voice_reserve_for_call", {
    p_business_id: businessId,
    p_call_control_id: callControlId,
    p_tier: tier,
    p_max_concurrent: concurrent,
    p_stripe_period_start: periodStart,
    p_tier_cap_seconds: cap,
    p_min_grant_seconds: 60,
    p_max_grant_seconds: 900
  });

  if (resErr) {
    console.error("reserve", resErr);
    await answerThenSpeak(apiKey, callControlId, VOICE_MSG_SYSTEM_ERROR);
    return new Response(JSON.stringify({ ok: true, path: "reserve_error" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const res = reserveResult as {
    ok?: boolean;
    reason?: string;
    grant_seconds?: number;
    duplicate?: boolean;
  };

  if (!res?.ok) {
    if (res?.reason === "concurrent_limit") {
      await rejectIncomingCall(apiKey, callControlId, "USER_BUSY");
    } else {
      await answerThenSpeak(apiKey, callControlId, VOICE_MSG_QUOTA_EXHAUSTED);
    }
    return new Response(JSON.stringify({ ok: true, path: res?.reason ?? "blocked" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const { data: settings } = await supabase
    .from("business_telnyx_settings")
    .select("bridge_last_heartbeat_at, bridge_media_wss_origin, bridge_media_path")
    .eq("business_id", businessId)
    .maybeSingle();

  const heartbeatTtlSec = 120;
  const hb = settings?.bridge_last_heartbeat_at
    ? new Date(settings.bridge_last_heartbeat_at as string).getTime()
    : 0;
  if (!hb || Date.now() - hb > heartbeatTtlSec * 1000) {
    await answerThenSpeak(apiKey, callControlId, VOICE_MSG_BRIDGE_DEGRADED);
    await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    return new Response(JSON.stringify({ ok: true, path: "bridge_down" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const origin =
    (routeRow.media_wss_origin as string | null) ??
    (settings?.bridge_media_wss_origin as string | null) ??
    defaultBridgeOrigin;
  const path =
    (routeRow.media_path as string | null) ??
    (settings?.bridge_media_path as string | null) ??
    "/voice/stream";

  if (!origin) {
    await answerThenSpeak(apiKey, callControlId, VOICE_MSG_BRIDGE_DEGRADED);
    await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    return new Response(JSON.stringify({ ok: true, path: "no_bridge_origin" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const exp = Math.floor(Date.now() / 1000) + 120;
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const streamPayload: StreamPayloadV1 = {
    v: 1,
    call_control_id: callControlId,
    business_id: businessId,
    to_e164: toE164,
    exp,
    nonce
  };
  const mac = await signStreamUrlMac(streamPayload, streamSecret);

  const expiresAt = new Date((exp + 60) * 1000).toISOString();
  const { error: nonceErr } = await supabase.from("stream_url_nonces").insert({
    nonce,
    expires_at: expiresAt
  });
  if (nonceErr) {
    console.error("nonce", nonceErr);
    await answerThenSpeak(apiKey, callControlId, VOICE_MSG_SYSTEM_ERROR);
    await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    return new Response(JSON.stringify({ ok: true, path: "nonce_error" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const base = origin.replace(/\/$/, "");
  const pth = path.startsWith("/") ? path : `/${path}`;
  const qs = new URLSearchParams({
    v: "1",
    call_control_id: callControlId,
    business_id: businessId,
    to_e164: toE164,
    exp: String(exp),
    nonce,
    mac
  });
  const streamUrl = `${base}${pth}?${qs.toString()}`.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");

  const answerRes = await telnyxAnswerStream(apiKey, callControlId, streamUrl);
  if (!answerRes.ok) {
    const errText = await answerRes.text();
    console.error("answer failed", answerRes.status, errText.slice(0, 500));
    await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    if (Date.now() > deadline) {
      return new Response("Timeout", { status: 500 });
    }
    return new Response("Answer failed", { status: 500 });
  }

  await supabase.rpc("voice_mark_answer_issued", { p_call_control_id: callControlId });

  if (Date.now() > deadline) {
    return new Response(JSON.stringify({ ok: true, slow: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ ok: true, path: "answered" }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});
