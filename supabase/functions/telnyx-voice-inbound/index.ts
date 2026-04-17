/**
 * Telnyx Programmable Voice: call.initiated → verify, dedupe, reserve, answer with signed media stream URL (customer VPS bridge runs Gemini Live when `GOOGLE_API_KEY` is set there).
 *
 * Secrets: TELNYX_API_KEY, TELNYX_PUBLIC_KEY, STREAM_URL_SIGNING_SECRET,
 *          SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *          BRIDGE_MEDIA_WSS_ORIGIN (optional fallback when route has no origin)
 * Optional: STRIPE_SECRET_KEY — JIT refresh of subscription period cache (§4.2) when TTL/rollover requires it.
 * Optional: VOICE_AI_STREAM_ENABLED — set to `false` for rollout guard: answer+speak only (no media stream).
 *
 * HTTP semantics: many logical errors (missing call fields, subscription/period issues) respond with **200**
 * and a Telnyx command to reject/hang up so Telnyx treats the webhook as delivered and does not retry.
 * Some paths after answer may return **5xx**; use logs/telemetry to distinguish.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { header, verifyTelnyxWebhook } from "../_shared/telnyx_webhook.ts";
import { signStreamUrlMac, type StreamPayloadV1 } from "../_shared/stream_url.ts";
import { resolveEnterpriseVoiceReservation } from "../_shared/enterprise_limits.ts";
import { VOICE_RES_LIMITS } from "../_shared/voice_reservation_limits.ts";
import {
  VOICE_MSG_BRIDGE_DEGRADED,
  VOICE_MSG_CONCURRENT_LIMIT,
  VOICE_MSG_QUOTA_EXHAUSTED,
  VOICE_MSG_STREAM_ROLLOUT_DISABLED,
  VOICE_MSG_SYSTEM_ERROR,
  VOICE_MSG_UNCONFIGURED_NUMBER
} from "../_shared/voice_messages.ts";
import { normalizeE164 } from "../_shared/normalize_e164.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { answerThenSpeak, telnyxAnswerWithStream } from "../_shared/telnyx_call_actions.ts";
import {
  cacheLooksValidForQuotaAfterJitFailure,
  STRIPE_PERIOD_ROLLOVER_GRACE_MS,
  subscriptionPeriodNeedsRefresh,
  type SubscriptionPeriodRow
} from "../_shared/stripe_voice_period.ts";
import {
  readTelnyxWebhookRateLimits,
  telnyxWebhookClientIp,
  telnyxWebhookRateAllow
} from "../_shared/telnyx_edge_guard.ts";

const MAX_BODY = 256 * 1024;
const HANDLER_MS = 8000;
const STRIPE_JIT_FETCH_MS = 4500;

async function fetchStripeSubscriptionPeriods(
  stripeSecret: string,
  stripeSubscriptionId: string
): Promise<{ start: string; end: string } | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), STRIPE_JIT_FETCH_MS);
  const res = await fetch(
    `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(stripeSubscriptionId)}`,
    { headers: { Authorization: `Bearer ${stripeSecret}` }, signal: ac.signal }
  ).finally(() => clearTimeout(t));
  if (!res.ok) {
    console.error("Stripe subscription HTTP", res.status, (await res.text()).slice(0, 500));
    return null;
  }
  const j = (await res.json()) as { current_period_start?: unknown; current_period_end?: unknown };
  if (typeof j.current_period_start !== "number" || typeof j.current_period_end !== "number") {
    return null;
  }
  return {
    start: new Date(j.current_period_start * 1000).toISOString(),
    end: new Date(j.current_period_end * 1000).toISOString()
  };
}

async function persistSubscriptionPeriodCache(
  supabase: ReturnType<typeof createClient>,
  row: SubscriptionPeriodRow,
  start: string,
  end: string
): Promise<boolean> {
  const stripe_subscription_cached_at = new Date().toISOString();
  const { error } = await supabase
    .from("subscriptions")
    .update({
      stripe_current_period_start: start,
      stripe_current_period_end: end,
      stripe_subscription_cached_at
    })
    .eq("id", row.id);
  if (error) {
    console.error("subscriptions period cache update", error);
    return false;
  }
  return true;
}

function tierCapSeconds(tier: string, enterpriseLimitsRaw: unknown): number {
  if (tier === "enterprise") {
    return resolveEnterpriseVoiceReservation(enterpriseLimitsRaw).tierCapSeconds;
  }
  if (tier === "standard") {
    return VOICE_RES_LIMITS.standard.voiceIncludedSecondsPerStripePeriod;
  }
  return VOICE_RES_LIMITS.starter.voiceIncludedSecondsPerStripePeriod;
}

function maxConcurrent(tier: string, enterpriseLimitsRaw: unknown): number {
  if (tier === "enterprise") {
    return resolveEnterpriseVoiceReservation(enterpriseLimitsRaw).maxConcurrent;
  }
  if (tier === "standard") {
    return VOICE_RES_LIMITS.standard.maxConcurrentCalls;
  }
  return VOICE_RES_LIMITS.starter.maxConcurrentCalls;
}

function envVoiceAiStreamEnabled(): boolean {
  const v = (Deno.env.get("VOICE_AI_STREAM_ENABLED") ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
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

  const supabase = createClient(supabaseUrl, serviceKey);

  // Cap on the number of bytes we will pull into memory for the webhook body. The
  // Content-Length check is a fast-fail for honest senders, but chunked uploads can
  // omit Content-Length or lie about it, so we also enforce the limit during the read
  // and abort as soon as we cross it rather than letting an arbitrarily large body
  // accumulate before a post-read size check.
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) {
    await telemetryRecord(supabase, "edge_webhook_rejected", {
      reason: "size",
      route: "telnyx_voice_inbound"
    });
    return new Response("Payload too large", { status: 413 });
  }

  const rawBody = await (async (): Promise<string | null> => {
    const reader = req.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY) {
        try { await reader.cancel(); } catch { /* best-effort */ }
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder().decode(out);
  })();

  if (rawBody === null) {
    await telemetryRecord(supabase, "edge_webhook_rejected", {
      reason: "size",
      route: "telnyx_voice_inbound"
    });
    return new Response("Payload too large", { status: 413 });
  }

  const clientIp = telnyxWebhookClientIp(req);
  const rate = await telnyxWebhookRateAllow(
    supabase,
    clientIp,
    "telnyx_voice_inbound",
    readTelnyxWebhookRateLimits((k) => Deno.env.get(k))
  );
  if (!rate.ok) {
    await telemetryRecord(supabase, "edge_webhook_rejected", {
      reason: "rate",
      route: "telnyx_voice_inbound",
      detail: rate.raw
    });
    return new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
      status: 429,
      headers: { "Content-Type": "application/json" }
    });
  }

  const sig = header(req, "telnyx-signature-ed25519");
  const ts = header(req, "telnyx-timestamp");
  const v = await verifyTelnyxWebhook(rawBody, sig, ts, publicKey);
  if (!v.ok) {
    await telemetryRecord(supabase, "telnyx_webhook_signature_reject", {
      class: v.reason,
      route: "telnyx_voice_inbound"
    });
    return new Response(JSON.stringify({ ok: false, error: "bad_signature" }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
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
      route: "telnyx_voice_inbound",
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
    return new Response(JSON.stringify({ ok: false, error: "missing_call_fields" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
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
    .select(
      "id, stripe_subscription_id, stripe_current_period_start, stripe_current_period_end, stripe_subscription_cached_at"
    )
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

  if (!sub?.id) {
    console.error(
      "voice inbound: no subscription row (ops: ensure subscriptions row exists for business or use comp flow with period cache)",
      { businessId }
    );
    await answerThenSpeak(apiKey, callControlId, VOICE_MSG_SYSTEM_ERROR);
    return new Response(JSON.stringify({ ok: true, path: "no_subscription" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

  let periodRow: SubscriptionPeriodRow = {
    id: sub.id as string,
    stripe_subscription_id: (sub.stripe_subscription_id as string | null) ?? null,
    stripe_current_period_start: (sub.stripe_current_period_start as string | null) ?? null,
    stripe_current_period_end: (sub.stripe_current_period_end as string | null) ?? null,
    stripe_subscription_cached_at: (sub.stripe_subscription_cached_at as string | null) ?? null
  };

  const needsJit = subscriptionPeriodNeedsRefresh(periodRow, stripeSecret);
  let jitFailed = false;
  if (needsJit) {
    const sid = periodRow.stripe_subscription_id;
    if (sid) {
      const fetched = await fetchStripeSubscriptionPeriods(stripeSecret, sid);
      if (fetched) {
        periodRow = {
          ...periodRow,
          stripe_current_period_start: fetched.start,
          stripe_current_period_end: fetched.end,
          stripe_subscription_cached_at: new Date().toISOString()
        };
        const ok = await persistSubscriptionPeriodCache(supabase, periodRow, fetched.start, fetched.end);
        if (!ok) {
          console.error(
            "voice inbound: Stripe period refreshed in-process but DB cache write failed",
            { businessId }
          );
        }
      } else {
        jitFailed = true;
        console.error("voice inbound: JIT Stripe subscription fetch failed (§4.2)", { businessId });
      }
    } else {
      jitFailed = true;
      console.error("voice inbound: period cache refresh required but no stripe_subscription_id", {
        businessId
      });
    }
  }

  if (jitFailed && needsJit) {
    const nowMs = Date.now();
    if (cacheLooksValidForQuotaAfterJitFailure(periodRow, nowMs)) {
      console.warn("voice inbound: jit_stripe_fail_proceed_cached", { businessId });
      await telemetryRecord(supabase, "jit_stripe_fail_proceed_cached", { business_id: businessId });
    } else {
      console.error("voice inbound: jit_stripe_fail_block", { businessId });
      await telemetryRecord(supabase, "jit_stripe_fail_block", { business_id: businessId });
      await answerThenSpeak(apiKey, callControlId, VOICE_MSG_SYSTEM_ERROR);
      return new Response(JSON.stringify({ ok: true, path: "jit_stripe_fail_block" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  const pastEnd =
    !!periodRow.stripe_current_period_end &&
    Date.now() >
      new Date(periodRow.stripe_current_period_end as string).getTime() + STRIPE_PERIOD_ROLLOVER_GRACE_MS;
  if (pastEnd) {
    console.error("voice inbound: stripe period cache past period_end", { businessId });
    await answerThenSpeak(apiKey, callControlId, VOICE_MSG_SYSTEM_ERROR);
    return new Response(JSON.stringify({ ok: true, path: "period_cache_stale" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (!periodRow.stripe_current_period_start || !periodRow.stripe_current_period_end) {
    console.error(
      "voice inbound: missing cached Stripe billing period bounds (ops: comp/manual accounts need stripe_current_period_* set, e.g. Stripe sync or admin backfill)",
      { businessId }
    );
    await answerThenSpeak(apiKey, callControlId, VOICE_MSG_SYSTEM_ERROR);
    return new Response(JSON.stringify({ ok: true, path: "no_period_bounds" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const periodStart = new Date(periodRow.stripe_current_period_start as string).toISOString();

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
      await answerThenSpeak(apiKey, callControlId, VOICE_MSG_CONCURRENT_LIMIT);
      await telemetryRecord(supabase, "voice_concurrent_limit_spoken", {
        business_id: businessId,
        call_control_id: callControlId
      });
    } else {
      await answerThenSpeak(apiKey, callControlId, VOICE_MSG_QUOTA_EXHAUSTED);
    }
    return new Response(JSON.stringify({ ok: true, path: res?.reason ?? "blocked" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const { data: issuedRow } = await supabase
    .from("voice_reservations")
    .select("answer_issued_at")
    .eq("call_control_id", callControlId)
    .maybeSingle();
  if (issuedRow?.answer_issued_at) {
    return new Response(JSON.stringify({ ok: true, path: "already_answered" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const { data: settings } = await supabase
    .from("business_telnyx_settings")
    .select("bridge_last_heartbeat_at, bridge_media_wss_origin, bridge_media_path")
    .eq("business_id", businessId)
    .maybeSingle();

  // Plan §5 health hysteresis: the bridge posts a heartbeat every 30s. A single missed write
  // (e.g. transient DB hiccup or cold restart) should NOT flip inbound calls to the degraded
  // path. Default TTL = 150s requires roughly 5 missed beats before we declare the bridge down,
  // which is a hard-failure signal rather than flap. Operators can tune this via env.
  const heartbeatTtlSec = (() => {
    const raw = Number(Deno.env.get("BRIDGE_HEARTBEAT_TTL_SEC") ?? "150");
    return Number.isFinite(raw) && raw >= 60 ? Math.floor(raw) : 150;
  })();
  const hb = settings?.bridge_last_heartbeat_at
    ? new Date(settings.bridge_last_heartbeat_at as string).getTime()
    : 0;
  if (!hb || Date.now() - hb > heartbeatTtlSec * 1000) {
    await answerThenSpeak(apiKey, callControlId, VOICE_MSG_BRIDGE_DEGRADED);
    const { error: relErr } = await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    if (relErr) console.error("voice_release_reservation_on_answer_fail", relErr);
    return new Response(JSON.stringify({ ok: true, path: "bridge_down" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const origin =
    (routeRow.media_wss_origin as string | null) ??
    (settings?.bridge_media_wss_origin as string | null) ??
    defaultBridgeOrigin;
  const pathRaw =
    (routeRow.media_path as string | null) ??
    (settings?.bridge_media_path as string | null) ??
    "/voice/stream";
  const pathTrimmed = pathRaw.trim().replace(/\/+$/, "") || "/voice/stream";
  const path = pathTrimmed.startsWith("/") ? pathTrimmed : `/${pathTrimmed}`;

  if (!origin) {
    await answerThenSpeak(apiKey, callControlId, VOICE_MSG_BRIDGE_DEGRADED);
    const { error: relErr } = await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    if (relErr) console.error("voice_release_reservation_on_answer_fail", relErr);
    return new Response(JSON.stringify({ ok: true, path: "no_bridge_origin" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (!envVoiceAiStreamEnabled()) {
    await answerThenSpeak(apiKey, callControlId, VOICE_MSG_STREAM_ROLLOUT_DISABLED);
    const { error: relRollErr } = await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    if (relRollErr) console.error("voice_release_reservation_on_answer_fail", relRollErr);
    await telemetryRecord(supabase, "voice_rollout_stream_disabled", {
      business_id: businessId,
      call_control_id: callControlId
    });
    return new Response(JSON.stringify({ ok: true, path: "stream_rollout_disabled" }), {
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
    const { error: relErr } = await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    if (relErr) console.error("voice_release_reservation_on_answer_fail", relErr);
    return new Response(JSON.stringify({ ok: true, path: "nonce_error" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const base = origin.replace(/\/$/, "");
  const pth = path;
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

  const answerRes = await telnyxAnswerWithStream(apiKey, callControlId, { streamUrl });
  if (!answerRes.ok) {
    const errText = await answerRes.text();
    console.error("answer failed", answerRes.status, errText.slice(0, 500));
    await telemetryRecord(supabase, "voice_answer_fail", {
      call_control_id: callControlId,
      business_id: businessId,
      http_status: answerRes.status
    });
    const { error: relAnsErr } = await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    if (relAnsErr) console.error("voice_release_reservation_on_answer_fail", relAnsErr);
    if (Date.now() > deadline) {
      return new Response("Timeout", { status: 500 });
    }
    return new Response("Answer failed", { status: 500 });
  }

  const { error: markErr, data: markData } = await supabase.rpc("voice_mark_answer_issued", {
    p_call_control_id: callControlId
  });
  if (markErr) {
    console.error("voice_mark_answer_issued", markErr);
    await telemetryRecord(supabase, "voice_mark_answer_issued_fail", {
      business_id: businessId,
      call_control_id: callControlId,
      transport: "rpc_error"
    });
    if (Date.now() > deadline) {
      return new Response("Timeout", { status: 500 });
    }
    return new Response(JSON.stringify({ ok: false, error: "mark_answer_issued" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  const mark = markData as { ok?: boolean; reason?: string } | null;
  if (!mark || mark.ok !== true) {
    console.error("voice_mark_answer_issued not ok", markData);
    await telemetryRecord(supabase, "voice_mark_answer_issued_fail", {
      business_id: businessId,
      call_control_id: callControlId,
      reason: mark?.reason ?? "not_ok"
    });
    if (Date.now() > deadline) {
      return new Response("Timeout", { status: 500 });
    }
    return new Response(JSON.stringify({ ok: false, error: "mark_answer_issued", detail: mark?.reason }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  await telemetryRecord(supabase, "voice_inbound_stream_answered", {
    business_id: businessId,
    call_control_id: callControlId
  });

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
  })();

  if (response.ok) {
    const { error: mErr } = await supabase.rpc("telnyx_webhook_mark_complete", { p_event_id: eventId });
    if (mErr) console.error("telnyx_webhook_mark_complete", mErr);
  }
  return response;
});
