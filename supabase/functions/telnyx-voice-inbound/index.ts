/**
 * Telnyx Programmable Voice: call.initiated → verify, dedupe, reserve, answer with signed media stream URL (customer VPS bridge runs Gemini Live when `GOOGLE_API_KEY` is set there).
 *
 * Secrets: TELNYX_API_KEY, TELNYX_PUBLIC_KEY, STREAM_URL_SIGNING_SECRET,
 *          SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *          BRIDGE_MEDIA_WSS_ORIGIN (optional fallback when route has no origin)
 * Optional: STRIPE_SECRET_KEY, JIT refresh of subscription period cache (§4.2) when TTL/rollover requires it.
 * Optional: VOICE_AI_STREAM_ENABLED, set to `false` for rollout guard: answer+speak only (no media stream).
 *
 * HTTP semantics: many logical errors (missing call fields, subscription/period issues) respond with **200**
 * and a Telnyx command to reject/hang up so Telnyx treats the webhook as delivered and does not retry.
 * Some paths after answer may return **5xx**; use logs/telemetry to distinguish.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { header, verifyTelnyxWebhook } from "../_shared/telnyx_webhook.ts";
import { signStreamUrlMac, type StreamPayloadV2 } from "../_shared/stream_url.ts";
import { checkVoiceBudgetAvailable, reserveVoiceBudget } from "../_shared/voice_reserve.ts";
import {
  capMicrosForTier,
  DEFAULT_CHAT_SPEND_CAP_MICROS,
  readActiveChatCreditMicros,
  resolveChatPeriodStart,
  STARTER_CHAT_SPEND_CAP_MICROS
} from "../_shared/chat_spend_cap.ts";
import { inboundSmsBody, telnyxSendSms } from "../_shared/telnyx_sms_compliance.ts";
import {
  VOICE_MSG_UNCONFIGURED_NUMBER,
  voiceMessageForLocale
} from "../_shared/voice_messages.ts";
import { telnyxTtsLanguage, type EdgeLocale } from "../_shared/edge_messages.ts";
import { normalizeE164 } from "../_shared/normalize_e164.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { systemLog } from "../_shared/system_log.ts";
import {
  answerThenSpeak,
  isCallAlreadyEndedResponse,
  telnyxAnswerPlain,
  telnyxAnswerWithStream,
  telnyxHangupCall,
  telnyxSendDtmf,
  telnyxSpeak,
  telnyxTransferCall
} from "../_shared/telnyx_call_actions.ts";
import {
  AI_FIRST_BRIEF_LOOKBACK_MINUTES,
  buildHandoffContext,
  buildPreCallBrief,
  encodeHandoffClientState,
  planAiFirstAccept,
  type HandoffContext
} from "../_shared/voice_handoff.ts";
import { attachAiStream, resolveBridgeTarget } from "../_shared/voice_ai_attach.ts";
import { encodeWtClientState } from "../_shared/warm_transfer_notify.ts";
import { compileVoiceFlow } from "../_shared/ai_flows/voice.ts";
import {
  matchVoiceFlowByCaller,
  resolveVoiceContactRefs
} from "../_shared/ai_flows/contact_ref.ts";
import type { AiFlowDefinition } from "../_shared/ai_flows/types.ts";
import { evaluateCustomerChannelGate } from "../_shared/customer_channel_gate.ts";
import {
  sendMissedCallAutotext,
  type MissedCallReason
} from "../_shared/missed_call_autotext.ts";
import { maybeSendMissedCallSpikeAlert } from "../_shared/missed_call_spike.ts";
import {
  readTelnyxWebhookRateLimits,
  telnyxWebhookClientIp,
  telnyxWebhookRateAllow
} from "../_shared/telnyx_edge_guard.ts";
import { pauseLeadAutomationOnCall } from "../_shared/ai_flows/customer_called.ts";
import { translatorAllowedForTier } from "../_shared/translator_tier.ts";

const MAX_BODY = 256 * 1024;
const HANDLER_MS = 8000;

// Shared AI-budget cap (micro-USD). Voice reads the SAME env vars as owner chat
// + SMS (OWNER_CHAT_SPEND_CAP_MICROS / _STARTER) so all three surfaces trip the
// shared owner_chat_model_spend fuse at the identical total for a tenant,
// hardcoding $5/$10 here would let voice refuse (or allow) calls at a different
// threshold than chat/SMS whenever ops tune the env caps. Mirrors
// sms-inbound-worker's CHAT_SPEND_CAP_MICROS(_STARTER). Falls back to the shared
// defaults ($10 / $5) exported from _shared/chat_spend_cap.ts.
const AI_BUDGET_CAP_MICROS = (() => {
  const n = Number(Deno.env.get("OWNER_CHAT_SPEND_CAP_MICROS"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CHAT_SPEND_CAP_MICROS;
})();
const AI_BUDGET_CAP_MICROS_STARTER = (() => {
  const n = Number(Deno.env.get("OWNER_CHAT_SPEND_CAP_MICROS_STARTER"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : STARTER_CHAT_SPEND_CAP_MICROS;
})();

// Gemini Live cost model, kept in lockstep with vps/voice-bridge/src/index.ts:
// combined two-way audio ≈ 0.375 micro-USD/ms (25 tok/s each way at the $3-in /
// $12-out audio rates). Used to size the AI-budget reservation and refusal margin.
const GEMINI_LIVE_MICROS_PER_MS = (() => {
  const n = Number(Deno.env.get("GEMINI_LIVE_MICROS_PER_MS"));
  return Number.isFinite(n) && n > 0 ? n : 0.375;
})();
const GEMINI_LIVE_SESSION_MIN_MS = (() => {
  const n = Number(Deno.env.get("GEMINI_LIVE_SESSION_MIN_MS"));
  return Number.isFinite(n) && n > 0 ? n : 30_000;
})();
const GEMINI_LIVE_SESSION_MAX_MS = (() => {
  const n = Number(Deno.env.get("GEMINI_LIVE_SESSION_MAX_MS"));
  return Number.isFinite(n) && n > 0 ? n : 14 * 60 * 1000;
})();
// Refuse a call when the remaining budget can't cover the bridge's MINIMUM
// session (≈ $0.011), so an answered call can always afford the min-session floor
// and never overspends the pool.
const AI_BUDGET_MIN_SESSION_MARGIN_MICROS = Math.ceil(
  GEMINI_LIVE_MICROS_PER_MS * GEMINI_LIVE_SESSION_MIN_MS
);
// Amount to HOLD against the shared AI budget at answer time, the max a single
// Live session could cost (env session cap × burn rate). The reserve RPC clamps
// this to the remaining headroom, so a fresh pool holds only this (≈ $0.32) per
// concurrent call while a near-exhausted pool holds exactly what's left.
const AI_BUDGET_MAX_SESSION_MICROS = Math.ceil(
  GEMINI_LIVE_MICROS_PER_MS * GEMINI_LIVE_SESSION_MAX_MS
);
// Reservation auto-expires (so a crashed/abandoned call frees its hold) after the
// max session plus a grace window; the bridge settles/releases well before this.
const AI_BUDGET_RESERVATION_TTL_SECONDS = Math.ceil(GEMINI_LIVE_SESSION_MAX_MS / 1000) + 300;

function envVoiceAiStreamEnabled(): boolean {
  const v = (Deno.env.get("VOICE_AI_STREAM_ENABLED") ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

/** Wait inside the handler (accept-digit pacing, safe-mode whisper spacing). */
function sleepMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function jsonOk(path: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: true, path, ...extra }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Minimal structural Supabase shape for `sendMissedAiCallSms`. Typed
 * structurally (not `SupabaseClient`) so the esm.sh createClient overloads can't
 * trip Deno's type-checker with a `SupabaseClient<any,...>` vs
 * `SupabaseClient<unknown, never, GenericSchema>` mismatch, same convention the
 * _shared modules use.
 */
type MissedCallSupabase = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: unknown) => {
        maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
};

/**
 * Text the owner that the AI coworker couldn't take a live call because the
 * shared AI budget is exhausted. Reuses the tenant's existing SMS fallback
 * config (`business_telnyx_settings`), same gate the voice-bridge's missed-call
 * SMS uses: only fires when `sms_fallback_enabled` is on AND a forward number +
 * messaging profile are set. We never text the caller. Best-effort; never
 * throws (the call is already being refused, this is a courtesy notification).
 */
async function sendMissedAiCallSms(
  supabase: MissedCallSupabase,
  params: { apiKey: string; businessId: string; callerE164: string }
): Promise<void> {
  try {
    const { data: settingsRow } = await supabase
      .from("business_telnyx_settings")
      .select(
        "sms_fallback_enabled, forward_to_e164, telnyx_sms_from_e164, telnyx_messaging_profile_id"
      )
      .eq("business_id", params.businessId)
      .maybeSingle();
    const s = settingsRow as
      | {
          sms_fallback_enabled?: boolean | null;
          forward_to_e164?: string | null;
          telnyx_sms_from_e164?: string | null;
          telnyx_messaging_profile_id?: string | null;
        }
      | null;
    if (!s?.sms_fallback_enabled || !s.forward_to_e164 || !s.telnyx_messaging_profile_id) {
      return;
    }
    const { data: bizRow } = await supabase
      .from("businesses")
      .select("name")
      .eq("id", params.businessId)
      .maybeSingle();
    const businessName =
      (bizRow as { name?: string | null } | null)?.name || "your business";
    const caller = params.callerE164 || "an unknown number";
    const text =
      `[${businessName}] your AI coworker couldn't take a live call from ${caller} ` +
      `because the AI budget for this billing period is used up. Please call them back, ` +
      `or add budget from your dashboard.`;
    const res = await telnyxSendSms({
      apiKey: params.apiKey,
      messagingProfileId: s.telnyx_messaging_profile_id,
      fromE164: s.telnyx_sms_from_e164 ?? undefined,
      toE164: s.forward_to_e164,
      text
    });
    if (!res.ok) {
      console.error("voice-inbound: missed AI call SMS failed", res.status, res.body.slice(0, 200));
    }
  } catch (err) {
    console.error(
      "voice-inbound: missed AI call SMS threw",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Text the owner that a lead with active automation just phoned in, so the
 * team knows the conversation moved to the phone channel (PRD "Customer
 * Called" state). Same settings gate as the other owner notices (forward
 * number + messaging profile configured); best-effort, never throws.
 */
async function notifyOwnerCustomerCalled(
  supabase: MissedCallSupabase,
  params: { apiKey: string; businessId: string; callerE164: string }
): Promise<void> {
  try {
    const { data: settingsRow } = await supabase
      .from("business_telnyx_settings")
      .select(
        "sms_fallback_enabled, forward_to_e164, telnyx_sms_from_e164, telnyx_messaging_profile_id"
      )
      .eq("business_id", params.businessId)
      .maybeSingle();
    const s = settingsRow as
      | {
          forward_to_e164?: string | null;
          telnyx_sms_from_e164?: string | null;
          telnyx_messaging_profile_id?: string | null;
        }
      | null;
    if (!s?.forward_to_e164 || !s.telnyx_messaging_profile_id) return;
    const text =
      `[AiFlow] Lead ${params.callerE164} just called in while an automation was ` +
      `waiting on them. Their follow-up texts are paused for 2 hours, the phone ` +
      `conversation owns this lead now.`;
    const res = await telnyxSendSms({
      apiKey: params.apiKey,
      messagingProfileId: s.telnyx_messaging_profile_id,
      fromE164: s.telnyx_sms_from_e164 ?? undefined,
      toE164: s.forward_to_e164,
      text
    });
    if (!res.ok) {
      console.error("customer-called owner SMS failed", res.status, res.body.slice(0, 200));
    }
  } catch (err) {
    console.error(
      "customer-called owner SMS threw",
      err instanceof Error ? err.message : String(err)
    );
  }
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

  // Only process inbound legs. A `transfer` spawns an outbound leg that may
  // also surface call.initiated on this webhook; processing it would try to
  // answer/route the leg we just dialed to a human. Skip anything not inbound.
  const direction = String(payload["direction"] ?? "");
  if (direction && direction !== "incoming") {
    return jsonOk("skipped_non_inbound", { direction });
  }
  const callControlId = String(payload["call_control_id"] ?? "");
  const toRaw = (payload["to"] ?? payload["To"]) as string | undefined;
  const toE164 = normalizeE164(toRaw);
  const fromRaw = (payload["from"] ?? payload["From"]) as string | undefined;
  // Best-effort normalize; `from` is used only for operator SMS fallback and
  // never as a routing key, so a missing/garbled value is fine.
  const fromE164Informational = (() => {
    try {
      return fromRaw ? normalizeE164(fromRaw) : "";
    } catch {
      return "";
    }
  })();
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

  // "Customer Called" pause (Lead Management PRD): a lead who phones instead
  // of texting must not keep receiving automated follow-ups mid-call. Resolve
  // their parked wait_for_reply runs with the customer_called sentinel, defer
  // their queued follow-ups, tag the contact, and (when configured) text the
  // owner. Fully best-effort and quick (indexed lookups), call routing below
  // must never be delayed or broken by this.
  if (fromE164Informational) {
    try {
      const paused = await pauseLeadAutomationOnCall(
        supabase,
        businessId,
        fromE164Informational
      );
      if (paused.resumedWaits > 0 || paused.deferredRuns > 0) {
        await telemetryRecord(supabase, "voice_customer_called_pause", {
          business_id: businessId,
          caller: fromE164Informational,
          resumed_waits: paused.resumedWaits,
          deferred_runs: paused.deferredRuns,
          tagged: paused.tagged
        });
        await systemLog(supabase, {
          businessId,
          source: "aiflow",
          level: "info",
          event: "ai_flow_customer_called",
          message: `Lead ${fromE164Informational} called in; paused their SMS automation (flow owns the phone turn now)`,
          payload: {
            caller: fromE164Informational,
            resumed_waits: paused.resumedWaits,
            deferred_runs: paused.deferredRuns
          }
        });
        await notifyOwnerCustomerCalled(supabase, {
          apiKey,
          businessId,
          callerE164: fromE164Informational
        });
      }
    } catch (e) {
      console.error("customer-called pause failed (continuing call routing)", e);
    }
  }

  // ── Reusable voice-routing primitives ──────────────────────────────────────
  // Both the new AiFlow voice path and the legacy tables drive the SAME Telnyx
  // call-control machine; these helpers are the single implementation so the two
  // sources can never diverge. Both run BEFORE the kill switch / reserve / Stripe
  // / bridge checks so a routed call never consumes concurrency or bills minutes.

  /** Give back a reservation whose media never attached (best-effort). */
  const releaseVoiceReservation = async (): Promise<void> => {
    const { error } = await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    if (error) console.error("ai-first: release reservation failed", error);
  };

  /**
   * Pre-call brief for an AI-first answer: the newest inbound text matching the
   * takeover's `brief_sms_contains` becomes `ai_takeover.context_note`, which
   * the bridge injects as "What you ALREADY KNOW about this person".
   *
   * Read straight from `sms_inbound_jobs` rather than from the flow run, because
   * the partner texts and then calls seconds later while the batch worker ticks
   * about once a minute: at answer time no flow step has executed yet. One
   * indexed read, and best-effort by contract: an uninformed AI still beats a
   * dropped seller, so any failure returns the context unchanged.
   */
  const withPreCallBrief = async (ctx: HandoffContext): Promise<HandoffContext> => {
    const ai = ctx.ai_takeover;
    const needle = (ai?.brief_sms_contains ?? "").trim().toLowerCase();
    if (!ai || !needle) return ctx;
    try {
      const cutoffIso = new Date(
        Date.now() - AI_FIRST_BRIEF_LOOKBACK_MINUTES * 60_000
      ).toISOString();
      const { data, error } = await supabase
        .from("sms_inbound_jobs")
        .select("payload")
        .eq("business_id", businessId)
        .gte("created_at", cutoffIso)
        // A text the tenant deleted must not come back as something the AI
        // "already knows" and asserts to a live customer, so the same
        // soft-delete stamp every other inbound reader honors is honored here.
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) {
        console.error("ai-first: pre-call brief read failed", error);
        return ctx;
      }
      for (const row of (data ?? []) as Array<{ payload?: Record<string, unknown> }>) {
        const env = (row.payload ?? {}) as { data?: { payload?: Record<string, unknown> } };
        const text = inboundSmsBody(env?.data?.payload ?? {});
        if (!text || !text.toLowerCase().includes(needle)) continue;
        const note = buildPreCallBrief(text);
        if (!note) continue;
        return { ...ctx, ai_takeover: { ...ai, context_note: note } };
      }
      console.warn("ai-first: no matching alert text for the pre-call brief", {
        businessId,
        needle
      });
    } catch (e) {
      console.error("ai-first: pre-call brief lookup threw", e);
    }
    return ctx;
  };

  /**
   * Transfer the answered A-leg to the chain's first human. Shared by the
   * ordinary ring-first start and by the AI-first fallback, so both leave the
   * session in the identical `ringing` state the call-end advancer expects.
   */
  const transferToFirstStep = async (
    ctx: HandoffContext,
    stage: string
  ): Promise<Response> => {
    const first = ctx.steps[0]!;
    // Normalize the ring window the same way planHandoffAdvance does for later
    // steps: a 0/missing ring_secs must NOT omit timeout_secs (Telnyx would then
    // ring the first human forever and the chain would never advance).
    const firstRingSecs = first.ring_secs > 0 ? Math.floor(first.ring_secs) : 20;
    const tf = await telnyxTransferCall(apiKey, callControlId, first.to_e164, {
      timeoutSecs: firstRingSecs,
      // A step target whose phone is off goes to carrier voicemail within a
      // couple of seconds, and a transfer auto-bridges on answer, so the
      // caller lands in a teammate's voicemail and the chain never advances.
      // Premium AMD's verdict lets the call-end handler un-stick that (see
      // handleMachineDetection's handoff branch).
      answeringMachineDetection: "premium",
      clientState: encodeHandoffClientState(callControlId, 0)
    });
    if (!tf.ok) {
      const errText = (await tf.text()).slice(0, 300);
      console.error("handoff: first transfer failed", tf.status, errText);
      await supabase
        .from("voice_handoff_sessions")
        .update({ status: "done" })
        .eq("call_control_id", callControlId);
      await telnyxHangupCall(apiKey, callControlId);
      await telemetryRecord(supabase, "voice_handoff_failed", {
        business_id: businessId,
        call_control_id: callControlId,
        stage,
        http_status: tf.status
      });
      return jsonOk("handoff_first_transfer_failed");
    }
    await telemetryRecord(supabase, "voice_handoff_started", {
      business_id: businessId,
      call_control_id: callControlId,
      from: fromE164Informational,
      steps: ctx.steps.length,
      has_ai_takeover: Boolean(ctx.ai_takeover)
    });
    await systemLog(supabase, {
      businessId,
      source: "voice",
      level: "info",
      event: "voice_handoff_started",
      message: `Started warm-handoff chain for ${fromE164Informational} (${ctx.steps.length} step(s), ai_takeover=${Boolean(ctx.ai_takeover)})`,
      payload: { call_control_id: callControlId, from: fromE164Informational }
    });
    return jsonOk("handoff_chain_start");
  };

  /**
   * AI-FIRST answer (`voice_ai_intake.answerFirst`): the AI takes the call
   * itself instead of ringing humans. Built for a partner line that calls the
   * moment a lead lands and where the referral is won by ACCEPTING on the call:
   * answer, press the accept digits once the announcement has had time to play,
   * reserve voice budget, then attach the Gemini bridge with whatever the
   * partner's own alert text already told us about the lead.
   *
   * The session stays `ringing` until the last possible moment, so every failure
   * before the media attaches simply rings the humans instead: a live person is
   * never dropped because the AI could not run.
   */
  const runAiFirstIntake = async (ctx: HandoffContext): Promise<Response> => {
    const ai = ctx.ai_takeover!;
    const fallback = async (stage: string, detail?: Record<string, unknown>): Promise<Response> => {
      console.warn("ai-first: falling back to the ring chain", { stage, ...detail });
      await telemetryRecord(supabase, "voice_ai_first_fallback", {
        business_id: businessId,
        call_control_id: callControlId,
        stage,
        ...detail
      });
      return await transferToFirstStep(ctx, `ai_first_fallback_${stage}`);
    };

    // Resolve the media target BEFORE answering or pressing anything: a dead
    // bridge must ring humans, not accept a referral nobody can service.
    const target = await resolveBridgeTarget(
      { supabase, apiKey, streamSecret, defaultBridgeOrigin },
      businessId,
      toE164,
      "ai-first"
    );

    const ans = await telnyxAnswerPlain(apiKey, callControlId);
    if (!ans.ok) {
      const errText = (await ans.text()).slice(0, 300);
      console.error("ai-first: answer failed", ans.status, errText);
      await supabase
        .from("voice_handoff_sessions")
        .update({ status: "done" })
        .eq("call_control_id", callControlId);
      await telemetryRecord(supabase, "voice_handoff_failed", {
        business_id: businessId,
        call_control_id: callControlId,
        stage: "ai_first_answer",
        http_status: ans.status
      });
      return jsonOk("handoff_answer_failed");
    }

    /**
     * Record that the partner's IVR has already received a tone from us. If this
     * call later falls back to the ring chain and both humans miss, the takeover
     * in telnyx-voice-call-end must NOT press again: another tone into a live
     * conversation can mis-route it. Stamped as soon as the FIRST digit lands,
     * so a sequence that fails halfway is still marked. Best-effort, since a
     * missed stamp only risks that duplicate press.
     */
    const stampAcceptSent = async (): Promise<void> => {
      const { error: stampErr } = await supabase
        .from("voice_handoff_sessions")
        .update({
          context: {
            ...ctx,
            ai_takeover: { ...ai, accept_sent: true }
          } as unknown as Record<string, unknown>
        })
        .eq("call_control_id", callControlId);
      if (stampErr) console.error("ai-first: could not stamp accept_sent", stampErr);
    };

    // IVR GATE: the bridge presses when it HEARS the announcement ask, so this
    // path does no pressing and no waiting at all. If the bridge turns out to be
    // unreachable below, falling back to the ring chain is what protects the
    // referral: the humans it rings are bridged to the partner's still-looping
    // menu and their own keypad accepts it, exactly as before AI-first.
    const gated = Boolean(ai.ivr_gate?.digit);
    // Accept the referral: the digits are what claim it, so they go out even
    // when the bridge is unreachable (we ring a human for the conversation
    // afterwards rather than letting the partner give the lead away).
    const accept = gated
      ? { digits: [] as Array<{ digit: string; after_seconds: number }>, mediaStartSeconds: 0 }
      : planAiFirstAccept(ai);
    let acceptSent = false;
    for (const press of accept.digits) {
      if (press.after_seconds > 0) await sleepMs(press.after_seconds * 1000);
      const dt = await telnyxSendDtmf(apiKey, callControlId, press.digit);
      if (!dt.ok) {
        console.error("ai-first: send_dtmf failed", dt.status, (await dt.text()).slice(0, 300));
        // Half-pressed still counts: the tones that DID land reached the IVR.
        if (acceptSent) await stampAcceptSent();
        return await fallback("dtmf", { digit: press.digit, http_status: dt.status });
      }
      if (!acceptSent) {
        acceptSent = true;
        await stampAcceptSent();
      }
    }

    if (!target) return await fallback("bridge_unavailable");

    // Same system-level gate every Gemini-voice path passes. Reserved AFTER the
    // accept digits (the referral is already ours) but strictly BEFORE media.
    const reserve = await reserveVoiceBudget(supabase, {
      businessId,
      callControlId,
      stripeSecret: Deno.env.get("STRIPE_SECRET_KEY") ?? ""
    });
    if (!reserve.ok) {
      return await fallback("no_budget", { reason: reserve.reason });
    }

    // Give the partner time to connect the customer before the AI speaks,
    // otherwise its greeting plays to hold music.
    if (accept.mediaStartSeconds > 0) await sleepMs(accept.mediaStartSeconds * 1000);

    // Flip to ai_intake LAST: this is what makes the bridge run the intake
    // persona (and expose only capture_lead) instead of the receptionist.
    const { error: intakeErr } = await supabase
      .from("voice_handoff_sessions")
      .update({ status: "ai_intake" })
      .eq("call_control_id", callControlId);
    if (intakeErr) {
      console.error("ai-first: could not flip the session to ai_intake", intakeErr);
      await releaseVoiceReservation();
      return await fallback("session_flip");
    }

    const attached = await attachAiStream(
      { supabase, apiKey, streamSecret, defaultBridgeOrigin },
      {
        businessId,
        callControlId,
        toE164,
        fromE164: fromE164Informational ?? "",
        origin: target.origin,
        path: target.path,
        translatorArmed: target.translatorArmed,
        label: "ai-first"
      }
    );
    if (!attached) {
      // Put the session back the way the ring chain expects before falling back.
      await supabase
        .from("voice_handoff_sessions")
        .update({ status: "ringing", current_step: 0 })
        .eq("call_control_id", callControlId);
      await releaseVoiceReservation();
      return await fallback("stream_start");
    }

    await telemetryRecord(supabase, "voice_ai_first_started", {
      business_id: businessId,
      call_control_id: callControlId,
      from: fromE164Informational,
      digits: accept.digits.length,
      ivr_gated: gated,
      has_brief: Boolean(ai.context_note)
    });
    await systemLog(supabase, {
      businessId,
      source: "voice",
      level: "info",
      event: "voice_ai_first_started",
      message: gated
        ? `AI answered the call from ${fromE164Informational} itself and is listening for the prompt to press ${ai.ivr_gate?.digit}`
        : `AI answered the call from ${fromE164Informational} itself, pressed ${accept.digits
            .map((d) => d.digit)
            .join("")}, and is handling the conversation`,
      payload: {
        call_control_id: callControlId,
        from: fromE164Informational,
        briefed: Boolean(ai.context_note)
      }
    });
    return jsonOk("ai_first_intake");
  };

  /**
   * Start a warm-handoff chain for `ctx`: persist the session, then either let
   * the AI answer it (answerFirst) or answer and transfer to the first human.
   * Returns a terminal Response when it acted (started, or failed after
   * answering), or null when it could NOT start (no steps / session write
   * failed) so the caller falls through to the next routing source / the normal
   * AI path.
   */
  const runHandoffChain = async (ctx: HandoffContext): Promise<Response | null> => {
    const first = ctx.steps[0];
    if (!first) {
      // No ringable human, make the misconfiguration observable, then fall
      // through (AI-only chains aren't supported; we always ring a human first).
      console.warn("handoff: chain has no usable steps; falling through", {
        businessId,
        from: fromE164Informational,
        has_ai_takeover: Boolean(ctx.ai_takeover)
      });
      await telemetryRecord(supabase, "voice_handoff_failed", {
        business_id: businessId,
        call_control_id: callControlId,
        stage: "no_steps"
      });
      return null;
    }
    // AI-first chains brief the AI from the partner's own alert text, which is
    // the only thing available this early: the referral SMS lands seconds before
    // the call and the batch worker has not run a single step yet.
    const aiFirst = ctx.ai_takeover?.answer_first === true;
    const briefed = aiFirst ? await withPreCallBrief(ctx) : ctx;
    // Persist the session FIRST, the chain can only advance (call.bridged /
    // call.hangup → telnyx-voice-call-end) if a session row keyed by this A-leg
    // call_control_id exists. If the write fails, fall through rather than ringing
    // a single dead-end leg with no Amy/AI fallback. Always written as `ringing`,
    // even for AI-first: that keeps the ring fallback one transfer away until the
    // media actually attaches.
    const { error: sessErr } = await supabase.from("voice_handoff_sessions").upsert(
      {
        call_control_id: callControlId,
        business_id: businessId,
        from_e164: fromE164Informational,
        chain_from_e164: fromE164Informational,
        status: "ringing",
        current_step: 0,
        context: briefed as unknown as Record<string, unknown>
      },
      { onConflict: "call_control_id" }
    );
    if (sessErr) {
      console.error("handoff: session upsert failed; skipping handoff", sessErr);
      await telemetryRecord(supabase, "voice_handoff_failed", {
        business_id: businessId,
        call_control_id: callControlId,
        stage: "session_upsert"
      });
      return null;
    }
    // AI-first owns the whole call from here (it answers itself, and every
    // failure inside falls back to ringing this same chain).
    if (aiFirst) return await runAiFirstIntake(briefed);
    // A warm transfer bridges an *answered* leg. Answer first (HomeLight's IVR
    // keeps looping while we ring), then transfer to the first step.
    const ans = await telnyxAnswerPlain(apiKey, callControlId);
    if (!ans.ok) {
      const errText = (await ans.text()).slice(0, 300);
      console.error("handoff: answer failed", ans.status, errText);
      await supabase
        .from("voice_handoff_sessions")
        .update({ status: "done" })
        .eq("call_control_id", callControlId);
      await telemetryRecord(supabase, "voice_handoff_failed", {
        business_id: businessId,
        call_control_id: callControlId,
        stage: "answer",
        http_status: ans.status
      });
      return jsonOk("handoff_answer_failed");
    }
    return await transferToFirstStep(briefed, "first_transfer");
  };

  /**
   * Single blind warm transfer: answer, optionally whisper to the caller, then
   * bridge straight to `toDst`. Always returns a terminal Response (it answered
   * the leg, so we can't fall through after that).
   */
  const runBlindTransfer = async (toDst: string, whisper: string): Promise<Response> => {
    // A warm transfer bridges an *answered* leg. Answer first and gate the
    // whisper + transfer on it, transferring an unanswered call is rejected by
    // Telnyx and strands the caller on dead air.
    const ans = await telnyxAnswerPlain(apiKey, callControlId);
    if (!ans.ok) {
      const errText = (await ans.text()).slice(0, 300);
      console.error("caller-rule answer failed", ans.status, errText);
      await telemetryRecord(supabase, "voice_caller_transfer_failed", {
        business_id: businessId,
        call_control_id: callControlId,
        http_status: ans.status
      });
      await systemLog(supabase, {
        businessId,
        source: "voice",
        level: "error",
        event: "voice_caller_transfer_failed",
        message: `Caller-rule answer refused by Telnyx (HTTP ${ans.status}); transfer skipped: ${errText}`,
        payload: { call_control_id: callControlId, http_status: ans.status, to: toDst }
      });
      return new Response(JSON.stringify({ ok: true, path: "caller_transfer_answer_failed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (whisper) {
      // Speak the short prompt to the caller, then pause long enough for it to
      // play before bridging (the same pacing the Safe Mode forward uses).
      const sp = await telnyxSpeak(apiKey, callControlId, whisper);
      if (!sp.ok) {
        console.error("caller-rule whisper failed", sp.status, (await sp.text()).slice(0, 300));
      }
      const delayRaw = Deno.env.get("VOICE_SAFE_MODE_TRANSFER_DELAY_MS");
      const delayMs = delayRaw ? Number(delayRaw) : 2500;
      if (Number.isFinite(delayMs) && delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
    // Tag the transfer's B leg so telnyx-voice-call-end can text the recipient
    // (and owner) the warm-transfer outcome on call.bridged / no-answer hangup.
    const transferRes = await telnyxTransferCall(apiKey, callControlId, toDst, {
      clientState: encodeWtClientState({
        businessId,
        callerE164: fromE164Informational ?? "",
        recipientE164: toDst
      })
    });
    if (!transferRes.ok) {
      const errText = await transferRes.text();
      console.error("caller-rule transfer failed", transferRes.status, errText.slice(0, 300));
      await telemetryRecord(supabase, "voice_caller_transfer_failed", {
        business_id: businessId,
        call_control_id: callControlId,
        http_status: transferRes.status
      });
      await systemLog(supabase, {
        businessId,
        source: "voice",
        level: "error",
        event: "voice_caller_transfer_failed",
        message: `Caller-rule transfer refused by Telnyx (HTTP ${transferRes.status}): ${errText.slice(0, 300)}`,
        payload: { call_control_id: callControlId, http_status: transferRes.status, to: toDst }
      });
      // Answered but the bridge was refused; hang up cleanly so the caller isn't
      // stranded on silent audio.
      const hup = await telnyxHangupCall(apiKey, callControlId);
      if (!hup.ok) {
        console.error("caller-rule hangup failed", hup.status, (await hup.text()).slice(0, 300));
      }
      return new Response(JSON.stringify({ ok: true, path: "caller_transfer_failed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    await telemetryRecord(supabase, "voice_caller_transferred", {
      business_id: businessId,
      call_control_id: callControlId
    });
    await systemLog(supabase, {
      businessId,
      source: "voice",
      level: "info",
      event: "voice_caller_transferred",
      message: `Warm-transferred caller ${fromE164Informational} to ${toDst} (voice routing)`,
      payload: { call_control_id: callControlId, from: fromE164Informational, to: toDst }
    });
    return new Response(JSON.stringify({ ok: true, path: "caller_transfer" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  // ── Voice routing as an AiFlow (preferred source) ──────────────────────────
  // A `voice`-triggered AiFlow whose trigger.fromE164 matches the caller is the
  // authored, CRUD-able replacement for the legacy voice_handoff_chains /
  // voice_caller_transfer_rules rows. Resolve it FIRST; the legacy tables remain
  // a fallback for any caller not yet migrated. A lookup/compile failure must
  // not strand the caller, log and fall through.
  if (fromE164Informational) {
    // Fetch the business's enabled voice flows and match in code: a literal
    // trigger.fromE164 equal to the caller wins first, then a trigger.fromRef
    // whose referenced saved contact/employee's LIVE numbers include the caller
    // (a ref can't be matched in SQL, the number lives in another table).
    // Paginate so every flow is considered, a fixed cap would silently skip
    // matching flows for businesses with large flow counts.
    const flowRows: { id?: string; definition?: unknown }[] = [];
    const pageSize = 100;
    for (let page = 0; ; page++) {
      const { data, error: flowErr } = await supabase
        .from("ai_flows")
        .select("id, definition")
        .eq("business_id", businessId)
        .eq("enabled", true)
        .is("deleted_at", null)
        .eq("definition->trigger->>channel", "voice")
        .order("created_at", { ascending: false })
        .range(page * pageSize, page * pageSize + pageSize - 1);
      if (flowErr) {
        console.error("ai_flows voice lookup", flowErr);
        break;
      }
      const rows = (data ?? []) as { id?: string; definition?: unknown }[];
      flowRows.push(...rows);
      if (rows.length < pageSize) break;
    }
    const flowRow = await matchVoiceFlowByCaller(
      supabase,
      businessId,
      flowRows,
      fromE164Informational
    );
    if (flowRow?.definition) {
      let plan: ReturnType<typeof compileVoiceFlow> = null;
      try {
        // Resolve dynamic contact refs (toRef/notifyRef → live numbers) BEFORE
        // the pure compiler runs; a resolution/compile failure must not strand
        // the caller, log and fall through to the legacy tables.
        const resolvedDef = await resolveVoiceContactRefs(
          supabase,
          businessId,
          flowRow.definition as AiFlowDefinition
        );
        plan = compileVoiceFlow(resolvedDef, toE164);
      } catch (e) {
        console.error("compileVoiceFlow", e);
      }
      if (plan?.kind === "transfer") {
        await telemetryRecord(supabase, "voice_flow_matched", {
          business_id: businessId,
          call_control_id: callControlId,
          flow_id: flowRow.id,
          kind: "transfer"
        });
        return await runBlindTransfer(plan.toE164, plan.whisper);
      }
      if (plan?.kind === "handoff") {
        await telemetryRecord(supabase, "voice_flow_matched", {
          business_id: businessId,
          call_control_id: callControlId,
          flow_id: flowRow.id,
          kind: "handoff"
        });
        const handled = await runHandoffChain(plan.context);
        if (handled) return handled;
        // Could not start (no steps / session write), fall through to legacy.
      }
    }
  }

  // Warm-handoff chain (§voice_handoff_chains), LEGACY fallback for callers not
  // yet migrated to a voice AiFlow above. The HomeLight live-transfer line rings
  // Dave, then Amy, then hands to the AI worker.
  if (fromE164Informational) {
    const { data: chainRow, error: chainErr } = await supabase
      .from("voice_handoff_chains")
      .select("steps, ai_takeover, enabled")
      .eq("business_id", businessId)
      .eq("from_e164", fromE164Informational)
      .maybeSingle();
    if (chainErr) {
      // A lookup failure must not strand the caller, log and fall through.
      console.error("voice_handoff_chains", chainErr);
    }
    const chain = chainRow as
      | { steps?: unknown; ai_takeover?: unknown; enabled?: boolean }
      | null;
    if (chain?.enabled) {
      const ctx = buildHandoffContext({
        toE164,
        steps: chain.steps,
        aiTakeover: chain.ai_takeover
      });
      const handled = await runHandoffChain(ctx);
      if (handled) return handled;
    }
  }

  // Per-caller warm-transfer rules (§voice_caller_transfer_rules), LEGACY
  // fallback. Certain inbound numbers (e.g. Clever's live-transfer line) connect
  // straight to a human, bypassing the AI bridge.
  if (fromE164Informational) {
    const { data: ruleRow, error: ruleErr } = await supabase
      .from("voice_caller_transfer_rules")
      .select("to_e164, whisper")
      .eq("business_id", businessId)
      .eq("from_e164", fromE164Informational)
      .maybeSingle();
    if (ruleErr) {
      // A rules lookup failure must not strand the caller, log and fall through
      // to the normal (AI) path rather than dropping the call.
      console.error("voice_caller_transfer_rules", ruleErr);
    }
    const rule = ruleRow as { to_e164?: string; whisper?: string | null } | null;
    if (rule?.to_e164) {
      return await runBlindTransfer(rule.to_e164, (rule.whisper ?? "").trim());
    }
  }

  // Armed expected-transfer window (§voice_expected_transfers): an AiFlow's
  // arm_voice_transfer step (e.g. after confirming a Clever live-transfer cue
  // with "Y") arms a short window during which the NEXT inbound call that
  // matched no per-caller routing above bridges straight to the target, the
  // concierge calls from a rotating number pool no fromE164 rule can cover.
  // The claim is a single conditional UPDATE (unexpired + unconsumed →
  // consumed), so concurrent calls can never both take one window. No caller-
  // number gate: the whole point is that the caller is unpredictable (and the
  // window is minutes long). A claim failure must not strand the caller, log
  // and fall through to the normal (AI) path.
  {
    const { data: windowRow, error: windowErr } = await supabase
      .from("voice_expected_transfers")
      .update({ consumed_at: new Date().toISOString(), consumed_call_control_id: callControlId })
      .eq("business_id", businessId)
      .is("consumed_at", null)
      .gt("expires_at", new Date().toISOString())
      .select("to_e164, whisper")
      .maybeSingle();
    if (windowErr) {
      console.error("voice_expected_transfers claim", windowErr);
    }
    const claimed = windowRow as { to_e164?: string; whisper?: string | null } | null;
    if (claimed?.to_e164) {
      await telemetryRecord(supabase, "voice_expected_transfer_matched", {
        business_id: businessId,
        call_control_id: callControlId,
        from: fromE164Informational ?? null
      });
      await systemLog(supabase, {
        businessId,
        source: "voice",
        level: "info",
        event: "voice_expected_transfer_matched",
        message: `Expected-call window claimed by ${fromE164Informational || "an unknown caller"}; transferring to ${claimed.to_e164}`,
        payload: { call_control_id: callControlId, from: fromE164Informational, to: claimed.to_e164 }
      });
      const transferRes = await runBlindTransfer(claimed.to_e164, (claimed.whisper ?? "").trim());
      // A refused answer/bridge must not burn the one-shot window, the
      // concierge may retry within the armed period, and that retry should
      // still reach a human. Re-open the window on failure (keyed to OUR
      // claim stamp, so a newer re-arm is never clobbered); the conditional
      // claim above still guarantees at most one transfer at a time.
      try {
        const body = (await transferRes.clone().json()) as { path?: string };
        if (body.path !== "caller_transfer") {
          const { error: releaseErr } = await supabase
            .from("voice_expected_transfers")
            .update({ consumed_at: null, consumed_call_control_id: null })
            .eq("business_id", businessId)
            .eq("consumed_call_control_id", callControlId);
          if (releaseErr) console.error("voice_expected_transfers release", releaseErr);
        }
      } catch (e) {
        console.error("voice_expected_transfers release", e);
      }
      return transferRes;
    }
  }

  // Missed-call spike alert (Standard/Enterprise perk): once the tenant's
  // refused-call count (`voice_call_blocked` system_logs rows) crosses the
  // daily threshold, tell the owner, callers hearing "line busy" is
  // otherwise invisible churn. Called from EVERY refusal path that writes
  // the ledger (reserve refusals + safe-mode-no-minutes via
  // missedCallFollowUp, and the AI-budget refusal directly). Never throws;
  // once-per-day dedup + tier gate live inside the helper.
  //
  // `refusedAt` is captured when the refusal happened, NOT when this check
  // runs, the auto-text work in between can cross UTC midnight, and the
  // spike day-key/count must describe the day the ledger row was written.
  const checkMissedCallSpike = async (refusedAt: Date) => {
    const spike = await maybeSendMissedCallSpikeAlert(supabase, {
      businessId,
      notifyUrl: `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/notifications`,
      bearer: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      now: refusedAt
    });
    if (spike.status === "sent") {
      await telemetryRecord(supabase, "voice_missed_call_spike_alert", {
        business_id: businessId,
        missed_calls_today: spike.count
      });
    }
  };

  // Missed-call auto-text (Standard/Enterprise perk): a refused caller gets
  // one follow-up SMS from the business's number so the conversation can
  // continue over text. Fully fail-safe inside the helper (tier gate,
  // per-tenant kill switch, opt-out, 1h dedup, monthly SMS cap). Shared by
  // the reserve-refusal branches below AND the safe-mode no-minutes branch.
  const missedCallFollowUp = async (missedReason: MissedCallReason) => {
    const refusedAt = new Date();
    const outcome = await sendMissedCallAutotext(supabase, {
      businessId,
      callerE164: fromE164Informational,
      reason: missedReason,
      telnyxApiKey: apiKey,
      defaultMessagingProfileId: Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") ?? "",
      defaultFromE164: Deno.env.get("TELNYX_SMS_FROM_E164") ?? ""
    });
    await telemetryRecord(supabase, "voice_missed_call_autotext", {
      business_id: businessId,
      call_control_id: callControlId,
      reason: missedReason,
      outcome: outcome.status,
      detail: outcome.reason ?? null
    });
    if (outcome.status === "sent") {
      await systemLog(supabase, {
        businessId,
        source: "voice",
        level: "info",
        event: "voice_missed_call_autotext_sent",
        message: `Missed-call auto-text sent to ${fromE164Informational} (${missedReason})`,
        payload: {
          call_control_id: callControlId,
          telnyx_message_id: outcome.telnyxMessageId ?? null
        }
      });
    } else if (outcome.status === "failed") {
      await systemLog(supabase, {
        businessId,
        source: "voice",
        level: "warn",
        event: "voice_missed_call_autotext_failed",
        message: `Missed-call auto-text failed: ${outcome.reason ?? "unknown"}`,
        payload: { call_control_id: callControlId, reason: missedReason }
      });
    }
    await checkMissedCallSpike(refusedAt);
  };

  // Kill switch + Safe Mode gate (§CustomerChannelGate).
  // Runs BEFORE reserve/Stripe/bridge checks so paused + forwarding calls never
  // consume concurrency or bill minutes. Safe Mode answers + speaks, then
  // transfers to the owner cell; kill switch answers + speaks, then hangs up
  // (via Telnyx's natural post-speak termination). We do not reserve capacity
  // on either branch.
  const { data: gateBizRow } = await supabase
    .from("businesses")
    .select("is_paused, customer_channels_enabled, default_customer_language, tier")
    .eq("id", businessId)
    .maybeSingle();
  const gateBiz = gateBizRow as
    | {
        is_paused?: boolean;
        customer_channels_enabled?: boolean;
        default_customer_language?: string | null;
        tier?: string | null;
      }
    | null;
  // System IVR (no AI stream) speaks the business's default customer language,
  // live detection is impossible on speak-only paths, per the i18n plan.
  const voiceLocale: EdgeLocale = gateBiz?.default_customer_language === "es" ? "es" : "en";
  const voiceTtsLang = telnyxTtsLanguage(voiceLocale);

  if (gateBiz?.is_paused || gateBiz?.customer_channels_enabled === false) {
    const { data: gateSettingsRow } = await supabase
      .from("business_telnyx_settings")
      .select("forward_to_e164")
      .eq("business_id", businessId)
      .maybeSingle();
    const gateSettings = gateSettingsRow as
      | { forward_to_e164?: string | null }
      | null;

    const gate = evaluateCustomerChannelGate({
      isPaused: Boolean(gateBiz?.is_paused),
      customerChannelsEnabled: gateBiz?.customer_channels_enabled !== false,
      forwardToE164: gateSettings?.forward_to_e164 ?? null
    });

    if (gate.kind === "paused") {
      await answerThenSpeak(
        apiKey,
        callControlId,
        voiceMessageForLocale("VOICE_MSG_PAUSED", voiceLocale),
        fetch,
        voiceTtsLang
      );
      await telemetryRecord(supabase, "voice_killswitch", {
        business_id: businessId,
        call_control_id: callControlId,
        is_paused: Boolean(gateBiz?.is_paused)
      });
      return new Response(JSON.stringify({ ok: true, path: "paused" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (gate.kind === "safe_mode_forward") {
      // Forwarding to the owner's cell still spends Telnyx voice minutes on the
      // outbound leg. If the tenant is out of voice minutes, DON'T forward,
      // speak the quota message and hang up (the cheapest path). Voice minutes
      // are a separate meter from the AI budget; this gate is only about Telnyx
      // minutes. Anything other than a definitive "quota_exhausted" (ok /
      // concurrent / indeterminate) still forwards as before.
      const fwdAvail = await checkVoiceBudgetAvailable(supabase, { businessId });
      if (fwdAvail.status === "blocked" && fwdAvail.reason === "quota_exhausted") {
        await answerThenSpeak(
          apiKey,
          callControlId,
          voiceMessageForLocale("VOICE_MSG_QUOTA_EXHAUSTED", voiceLocale),
          fetch,
          voiceTtsLang
        );
        await telemetryRecord(supabase, "voice_safe_mode_forward_skipped_no_minutes", {
          business_id: businessId,
          call_control_id: callControlId
        });
        await systemLog(supabase, {
          businessId,
          source: "voice",
          level: "warn",
          event: "voice_safe_mode_forward_skipped",
          message: "Safe-mode forward skipped: voice minutes exhausted",
          payload: { call_control_id: callControlId, reason: "quota_exhausted" }
        });
        // Also write the refusal ledger row: `voice_call_blocked` is what the
        // analytics answer-rate card AND the missed-call spike counter read,
        // a caller turned away here is just as missed as one refused by the
        // reserve path below. The safe-mode-specific event above stays for
        // ops diagnostics.
        await systemLog(supabase, {
          businessId,
          source: "voice",
          level: "warn",
          event: "voice_call_blocked",
          message: "Inbound call refused: quota_exhausted (safe-mode forward skipped)",
          payload: {
            call_control_id: callControlId,
            reason: "quota_exhausted",
            context: "safe_mode_forward"
          }
        });
        await missedCallFollowUp("quota_exhausted");
        return jsonOk("safe_mode_forward_no_minutes");
      }
      await answerThenSpeak(
        apiKey,
        callControlId,
        voiceMessageForLocale("VOICE_MSG_SAFE_MODE_CONNECTING", voiceLocale),
        fetch,
        voiceTtsLang
      );
      // Telnyx `speak` returns as soon as TTS is queued, not when playback
      // finishes. If we call `transfer` immediately, the call bridges to the
      // owner before the caller hears the "Connecting you now." confirmation.
      // Wait roughly long enough for the short prompt to finish. Configurable
      // for tests / regions where TTS pacing differs.
      const delayRaw = Deno.env.get("VOICE_SAFE_MODE_TRANSFER_DELAY_MS");
      const delayMs = delayRaw ? Number(delayRaw) : 2500;
      if (Number.isFinite(delayMs) && delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      // Tag the transfer's B leg like every other single-leg transfer
      // (caller-rule + receptionist transfer_to_owner) so telnyx-voice-call-end
      // records the forwarded call in Call history (completed/missed) and runs
      // the missed-forwarded follow-ups (caller auto-text, blocked ledger,
      // spike). Without this tag a safe-mode forward is invisible in the log.
      const transferRes = await telnyxTransferCall(
        apiKey,
        callControlId,
        gate.forwardToE164,
        {
          clientState: encodeWtClientState({
            businessId,
            callerE164: fromE164Informational ?? "",
            recipientE164: gate.forwardToE164
          })
        }
      );
      if (!transferRes.ok) {
        const errText = await transferRes.text();
        console.error("safe mode transfer failed", transferRes.status, errText.slice(0, 300));
        await telemetryRecord(supabase, "voice_safe_mode_forward_failed", {
          business_id: businessId,
          call_control_id: callControlId,
          http_status: transferRes.status
        });
        await systemLog(supabase, {
          businessId,
          source: "voice",
          level: "error",
          event: "voice_safe_mode_forward_failed",
          message: `Safe-mode transfer refused by Telnyx (HTTP ${transferRes.status}): ${errText.slice(0, 300)}`,
          payload: { call_control_id: callControlId, http_status: transferRes.status }
        });
        // The call has already been answered (we spoke "Connecting you now.")
        // and Telnyx refused the bridge. Without an explicit recovery the
        // caller sits on silent answered audio until Telnyx times the call
        // out. Play a short apology and hang up cleanly.
        const sp = await telnyxSpeak(
          apiKey,
          callControlId,
          voiceMessageForLocale("VOICE_MSG_SAFE_MODE_FORWARD_FAILED", voiceLocale),
          "female",
          fetch,
          voiceTtsLang
        );
        if (!sp.ok) {
          console.error(
            "safe mode failure speak",
            sp.status,
            (await sp.text()).slice(0, 300)
          );
        }
        // Delay so the apology finishes before we tear down. The failure
        // message is ~17 words (~6s of Polly TTS), substantially longer than
        // the "Connecting you now." prompt that sets the pre-transfer delay,
        // so we can't reuse 2500ms here, the caller would hear a truncated
        // "We're sorry, we could not con, " and then silence. Tied to the
        // message content: if VOICE_MSG_SAFE_MODE_FORWARD_FAILED changes,
        // update this constant in the same commit. We still honor the
        // transfer-delay env knob so tests that set it to 0 collapse this
        // delay too.
        const SAFE_MODE_FAILURE_HANGUP_DELAY_MS = 7000;
        const delayRawEndOverride = Deno.env.get("VOICE_SAFE_MODE_TRANSFER_DELAY_MS");
        const delayMsEnd = delayRawEndOverride
          ? Number(delayRawEndOverride)
          : SAFE_MODE_FAILURE_HANGUP_DELAY_MS;
        if (Number.isFinite(delayMsEnd) && delayMsEnd > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMsEnd));
        }
        const hup = await telnyxHangupCall(apiKey, callControlId);
        if (!hup.ok) {
          console.error(
            "safe mode failure hangup",
            hup.status,
            (await hup.text()).slice(0, 300)
          );
        }
        return new Response(
          JSON.stringify({ ok: true, path: "safe_mode_forward_failed" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      await telemetryRecord(supabase, "voice_safe_mode_forwarded", {
        business_id: businessId,
        call_control_id: callControlId
      });
      return new Response(
        JSON.stringify({ ok: true, path: "safe_mode_forwarded" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // System-level voice budget gate: every path that will spend Gemini voice
  // minutes reserves through the same helper (telnyx-voice-call-end's AI takeover
  // does too). A non-ok result means we must not open the AI bridge.
  const reserve = await reserveVoiceBudget(supabase, {
    businessId,
    callControlId,
    stripeSecret: Deno.env.get("STRIPE_SECRET_KEY") ?? ""
  });

  if (!reserve.ok) {
    const reason = reserve.reason;
    if (reason === "concurrent_limit") {
      await answerThenSpeak(
        apiKey,
        callControlId,
        voiceMessageForLocale("VOICE_MSG_CONCURRENT_LIMIT", voiceLocale),
        fetch,
        voiceTtsLang
      );
      await telemetryRecord(supabase, "voice_concurrent_limit_spoken", {
        business_id: businessId,
        call_control_id: callControlId
      });
      await systemLog(supabase, {
        businessId,
        source: "voice",
        level: "warn",
        event: "voice_call_blocked",
        message: `Inbound call refused: ${reason}`,
        payload: { call_control_id: callControlId, reason }
      });
      await missedCallFollowUp("concurrent_limit");
    } else if (reason === "quota_exhausted") {
      await answerThenSpeak(
        apiKey,
        callControlId,
        voiceMessageForLocale("VOICE_MSG_QUOTA_EXHAUSTED", voiceLocale),
        fetch,
        voiceTtsLang
      );
      await systemLog(supabase, {
        businessId,
        source: "voice",
        level: "warn",
        event: "voice_call_blocked",
        message: `Inbound call refused: ${reason}`,
        payload: { call_control_id: callControlId, reason }
      });
      await missedCallFollowUp("quota_exhausted");
    } else {
      // System fault (business/subscription/period/RPC) → generic error message.
      if (reason === "jit_stripe_fail_block") {
        await systemLog(supabase, {
          businessId,
          source: "voice",
          level: "error",
          event: "voice_jit_stripe_fail_block",
          message: "Call blocked: Stripe period lookup failed and no valid cached quota",
          payload: { call_control_id: callControlId }
        });
      }
      await answerThenSpeak(
        apiKey,
        callControlId,
        voiceMessageForLocale("VOICE_MSG_SYSTEM_ERROR", voiceLocale),
        fetch,
        voiceTtsLang
      );
    }
    return new Response(JSON.stringify({ ok: true, path: reason }), {
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
    .select(
      "bridge_last_heartbeat_at, bridge_media_wss_origin, bridge_media_path, translator_mode_enabled"
    )
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
    await answerThenSpeak(
      apiKey,
      callControlId,
      voiceMessageForLocale("VOICE_MSG_BRIDGE_DEGRADED", voiceLocale),
      fetch,
      voiceTtsLang
    );
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
    await answerThenSpeak(
      apiKey,
      callControlId,
      voiceMessageForLocale("VOICE_MSG_BRIDGE_DEGRADED", voiceLocale),
      fetch,
      voiceTtsLang
    );
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
    await answerThenSpeak(
      apiKey,
      callControlId,
      voiceMessageForLocale("VOICE_MSG_STREAM_ROLLOUT_DISABLED", voiceLocale),
      fetch,
      voiceTtsLang
    );
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

  // Shared AI-budget gate (hard stop). Placed HERE, after every branch that
  // exits without opening the Gemini bridge (paused/channel-off, safe-mode
  // forward, quota, already-answered, bridge-down/degraded, no-origin, and the
  // VOICE_AI_STREAM_ENABLED speak-only rollout), so it only fires for calls
  // that will actually attach the AI media stream and spend Gemini budget. Those
  // earlier speak-only paths consume NO AI budget, so an exhausted pool must not
  // preempt their intended messages with the "please text us" refusal.
  //
  // The AI coworker's Gemini spend (voice_task via the router + Gemini Live
  // via the bridge) is billed to the SAME $5/$10 AI budget pool as owner chat +
  // SMS (`owner_chat_model_spend`). Chat/SMS degrade to a local model when the
  // pool is exhausted, but a LIVE voice call can't, so this is a hard stop:
  // release the voice reservation, speak a short "please text us" message + hang
  // up, and text the owner about the missed call. Voice minutes (checked above)
  // stay a separate meter. Fails OPEN (resolveSmsChatCap never throws) so a read
  // blip can't wrongly refuse a call.
  {
    const { data: tierRow } = await supabase
      .from("businesses")
      .select("tier")
      .eq("id", businessId)
      .maybeSingle();
    const tier = (tierRow as { tier?: string | null } | null)?.tier ?? null;
    const tierCapMicros = capMicrosForTier(
      tier,
      AI_BUDGET_CAP_MICROS,
      AI_BUDGET_CAP_MICROS_STARTER
    );

    // Atomically RESERVE this call's max Gemini Live cost against the shared pool
    // (concurrency-safe: the RPC serializes per business and counts other active
    // holds), instead of a plain read that concurrent calls could each pass. The
    // hold makes overlapping calls see reduced budget and get shorter/refused
    // sessions; the bridge settles it to exact spend at teardown. We refuse when
    // the pool is fully committed OR the remaining headroom can't cover one
    // minimum session (so any answered call can afford the bridge's min-session
    // floor and never overspends). Fails OPEN: any RPC error proceeds without a
    // hold so a DB blip can't wrongly refuse a call.
    let refuseAiBudget = false;
    let effectiveCapMicros = tierCapMicros;
    try {
      const periodStart = await resolveChatPeriodStart(supabase, businessId);
      const credits = await readActiveChatCreditMicros(supabase, businessId);
      effectiveCapMicros = tierCapMicros + credits;
      const { data: resvData, error: resvErr } = await supabase.rpc("owner_chat_ai_reserve", {
        p_business_id: businessId,
        p_period_start: periodStart,
        p_call_control_id: callControlId,
        p_reserve_micros: AI_BUDGET_MAX_SESSION_MICROS,
        p_cap_micros: effectiveCapMicros,
        p_ttl_seconds: AI_BUDGET_RESERVATION_TTL_SECONDS
      });
      if (resvErr) {
        console.error("owner_chat_ai_reserve", resvErr);
      } else {
        const row = (Array.isArray(resvData) ? resvData[0] : resvData) as
          | { ok?: boolean; remaining_micros?: number | string; duplicate?: boolean }
          | null;
        const ok = Boolean(row?.ok);
        const remaining = Number(row?.remaining_micros ?? 0);
        const duplicate = Boolean(row?.duplicate);
        // On a Telnyx webhook RETRY the RPC returns duplicate=true for the hold
        // the first attempt already placed, the call was admitted (and may have
        // already bridged) then, so we must NOT re-apply the min-session refusal
        // (remaining excludes this call's own hold, so a now-tighter pool could
        // wrongly drop an in-flight call's hold + run the exhausted-speak path).
        if (!duplicate && (!ok || remaining < AI_BUDGET_MIN_SESSION_MARGIN_MICROS)) {
          refuseAiBudget = true;
          // Free the (clamped, sub-min-session) hold we just made before refusing.
          const { error: relResvErr } = await supabase.rpc("owner_chat_ai_release", {
            p_call_control_id: callControlId
          });
          if (relResvErr) console.error("owner_chat_ai_release", relResvErr);
        }
      }
    } catch (e) {
      console.error("ai-budget reserve failed (proceeding, fail-open)", e);
    }

    if (refuseAiBudget) {
      await answerThenSpeak(
        apiKey,
        callControlId,
        voiceMessageForLocale("VOICE_MSG_AI_BUDGET_EXHAUSTED", voiceLocale),
        fetch,
        voiceTtsLang
      );
      const { error: relErr } = await supabase.rpc("voice_release_reservation_on_answer_fail", {
        p_call_control_id: callControlId
      });
      if (relErr) console.error("voice_release_reservation_on_answer_fail", relErr);
      await sendMissedAiCallSms(supabase, {
        apiKey,
        businessId,
        callerE164: fromE164Informational ?? ""
      });
      await telemetryRecord(supabase, "voice_ai_budget_exhausted", {
        business_id: businessId,
        call_control_id: callControlId,
        effective_cap_micros: effectiveCapMicros
      });
      await systemLog(supabase, {
        businessId,
        source: "voice",
        level: "warn",
        event: "voice_call_blocked",
        message: "Inbound call refused: ai_budget_exhausted",
        payload: { call_control_id: callControlId, reason: "ai_budget_exhausted" }
      });
      // This refusal wrote the voice_call_blocked ledger but doesn't run the
      // missed-call auto-text (sendMissedAiCallSms above covers the caller),
      // so trigger the spike check directly.
      await checkMissedCallSpike(new Date());
      return jsonOk("ai_budget_exhausted");
    }
  }

  const exp = Math.floor(Date.now() / 1000) + 120;
  const nonce = crypto.randomUUID().replace(/-/g, "");
  // v2: the caller number is part of the signed canonical so the bridge can
  // trust it for staff detection + customer-memory recognition (issue #268).
  // Empty string when Telnyx gave no caller id, still signed so the bridge's
  // verify matches exactly.
  const signedFromE164 = fromE164Informational ?? "";
  const streamPayload: StreamPayloadV2 = {
    v: 2,
    call_control_id: callControlId,
    business_id: businessId,
    to_e164: toE164,
    from_e164: signedFromE164,
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
    await answerThenSpeak(
      apiKey,
      callControlId,
      voiceMessageForLocale("VOICE_MSG_SYSTEM_ERROR", voiceLocale),
      fetch,
      voiceTtsLang
    );
    const { error: relErr } = await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    if (relErr) console.error("voice_release_reservation_on_answer_fail", relErr);
    // Free the AI-budget hold too, this call will never open the Gemini bridge.
    const { error: relAiErr } = await supabase.rpc("owner_chat_ai_release", {
      p_call_control_id: callControlId
    });
    if (relAiErr) console.error("owner_chat_ai_release", relAiErr);
    return new Response(JSON.stringify({ ok: true, path: "nonce_error" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const base = origin.replace(/\/$/, "");
  const pth = path;
  const qs = new URLSearchParams({
    v: "2",
    call_control_id: callControlId,
    business_id: businessId,
    to_e164: toE164,
    exp: String(exp),
    nonce,
    mac
  });
  // Caller number, transported as `from_e164_info` (unchanged param name) but
  // now SIGNED in the v2 canonical above, the bridge only trusts it (for staff
  // persona + memory recognition) when the v2 mac verifies. Set it whenever the
  // signed value is non-empty so the param round-trips into the canonical the
  // bridge rebuilds.
  if (signedFromE164) {
    qs.set("from_e164_info", signedFromE164);
  }
  const streamUrl = `${base}${pth}?${qs.toString()}`.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");

  // Translator mode arming. This has to be decided HERE, at answer, not when the
  // AI later transfers: Telnyx cannot re-point a running stream's target legs,
  // and restarting the stream would tear down the Live session (transcript,
  // reservation, and everything the caller already said). `both` is inert until
  // a second leg exists, so an armed call that never transfers behaves normally.
  // Standard+ only: Starter would burn included minutes on double-leg Gemini Live.
  const translatorArmed =
    (settings as { translator_mode_enabled?: boolean | null } | null)
      ?.translator_mode_enabled === true &&
    translatorAllowedForTier(gateBiz?.tier);
  const answerRes = await telnyxAnswerWithStream(apiKey, callControlId, {
    streamUrl,
    ...(translatorArmed ? { targetLegs: "both" as const } : {})
  });
  if (!answerRes.ok) {
    const errText = await answerRes.text();
    // The caller hanging up mid-ring is ordinary telephony, not a fault, and
    // the two differ in every way that matters downstream: what the operator
    // is told, and whether Telnyx should try again. See
    // isCallAlreadyEndedResponse for why it keys on the code.
    const callerGone = isCallAlreadyEndedResponse(answerRes.status, errText);
    if (callerGone) {
      console.log("answer skipped, caller already hung up", callControlId);
    } else {
      console.error("answer failed", answerRes.status, errText.slice(0, 500));
    }
    // Counted separately so `voice_answer_fail == 0` in scripts/rollout-verify.ts
    // keeps meaning "no answer is broken" rather than "nobody hung up early".
    await telemetryRecord(
      supabase,
      callerGone ? "voice_answer_caller_gone" : "voice_answer_fail",
      {
        call_control_id: callControlId,
        business_id: businessId,
        http_status: answerRes.status
      }
    );
    await systemLog(supabase, {
      businessId,
      source: "voice",
      level: callerGone ? "info" : "error",
      event: callerGone ? "voice_caller_hung_up_before_answer" : "voice_answer_failed",
      message: callerGone
        ? "Caller hung up before the call could be answered; nothing was missed."
        : `Telnyx answer failed (HTTP ${answerRes.status}): ${errText.slice(0, 300)}`,
      payload: { call_control_id: callControlId, http_status: answerRes.status }
    });
    const { error: relAnsErr } = await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    if (relAnsErr) console.error("voice_release_reservation_on_answer_fail", relAnsErr);
    // Free the AI-budget hold too, the bridge won't attach on a failed answer.
    const { error: relAiAnsErr } = await supabase.rpc("owner_chat_ai_release", {
      p_call_control_id: callControlId
    });
    if (relAiAnsErr) console.error("owner_chat_ai_release", relAiAnsErr);
    if (Date.now() > deadline) {
      return new Response("Timeout", { status: 500 });
    }
    // 200 for the hangup race: the reservation and the budget hold are already
    // released above, so there is no work left to retry, and a 500 asks Telnyx
    // to redeliver a webhook for a call that no longer exists.
    return callerGone
      ? new Response(JSON.stringify({ ok: true, path: "caller_hung_up_before_answer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      : new Response("Answer failed", { status: 500 });
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
  await systemLog(supabase, {
    businessId,
    source: "voice",
    level: "info",
    event: "voice_call_answered",
    message: "Inbound call answered with media stream to the voice bridge",
    payload: { call_control_id: callControlId }
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
