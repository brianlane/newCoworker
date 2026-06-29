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
import { signStreamUrlMac, type StreamPayloadV2 } from "../_shared/stream_url.ts";
import { reserveVoiceBudget } from "../_shared/voice_reserve.ts";
import {
  VOICE_MSG_BRIDGE_DEGRADED,
  VOICE_MSG_CONCURRENT_LIMIT,
  VOICE_MSG_PAUSED,
  VOICE_MSG_QUOTA_EXHAUSTED,
  VOICE_MSG_SAFE_MODE_CONNECTING,
  VOICE_MSG_SAFE_MODE_FORWARD_FAILED,
  VOICE_MSG_STREAM_ROLLOUT_DISABLED,
  VOICE_MSG_SYSTEM_ERROR,
  VOICE_MSG_UNCONFIGURED_NUMBER
} from "../_shared/voice_messages.ts";
import { normalizeE164 } from "../_shared/normalize_e164.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { systemLog } from "../_shared/system_log.ts";
import {
  answerThenSpeak,
  telnyxAnswerPlain,
  telnyxAnswerWithStream,
  telnyxHangupCall,
  telnyxSpeak,
  telnyxTransferCall
} from "../_shared/telnyx_call_actions.ts";
import {
  buildHandoffContext,
  encodeHandoffClientState
} from "../_shared/voice_handoff.ts";
import { evaluateCustomerChannelGate } from "../_shared/customer_channel_gate.ts";
import {
  readTelnyxWebhookRateLimits,
  telnyxWebhookClientIp,
  telnyxWebhookRateAllow
} from "../_shared/telnyx_edge_guard.ts";

const MAX_BODY = 256 * 1024;
const HANDLER_MS = 8000;

function envVoiceAiStreamEnabled(): boolean {
  const v = (Deno.env.get("VOICE_AI_STREAM_ENABLED") ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

function jsonOk(path: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: true, path, ...extra }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
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

  // Warm-handoff chain (§voice_handoff_chains). The HomeLight live-transfer
  // line rings Dave, then Amy, then hands to the AI worker. Runs BEFORE the
  // single-transfer caller rules and the kill switch / reserve / Stripe checks
  // so it never consumes concurrency or bills minutes. Matched on the
  // (normalized) caller id; a missing/garbled `from` can't match and falls
  // through to the normal path.
  if (fromE164Informational) {
    const { data: chainRow, error: chainErr } = await supabase
      .from("voice_handoff_chains")
      .select("steps, ai_takeover, enabled")
      .eq("business_id", businessId)
      .eq("from_e164", fromE164Informational)
      .maybeSingle();
    if (chainErr) {
      // A lookup failure must not strand the caller — log and fall through.
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
      const first = ctx.steps[0];
      if (first) {
        // Normalize the ring window the same way planHandoffAdvance does for
        // later steps: a 0/missing ring_secs must NOT omit timeout_secs (Telnyx
        // would then ring the first human forever and the chain would never
        // advance to Amy / AI takeout).
        const firstRingSecs = first.ring_secs > 0 ? Math.floor(first.ring_secs) : 20;
        // Persist the session FIRST — the chain can only advance (call.bridged /
        // call.hangup → telnyx-voice-call-end) if a session row keyed by this
        // A-leg call_control_id exists. If the write fails, skip the handoff and
        // fall through to the normal path rather than ringing a single dead-end
        // leg with no Amy/AI fallback.
        const { error: sessErr } = await supabase.from("voice_handoff_sessions").upsert(
          {
            call_control_id: callControlId,
            business_id: businessId,
            from_e164: fromE164Informational,
            chain_from_e164: fromE164Informational,
            status: "ringing",
            current_step: 0,
            context: ctx as unknown as Record<string, unknown>
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
        } else {
        // A warm transfer bridges an *answered* leg. Answer first (HomeLight's
        // IVR keeps looping while we ring), then transfer to the first step.
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
        const tf = await telnyxTransferCall(apiKey, callControlId, first.to_e164, {
          timeoutSecs: firstRingSecs,
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
            stage: "first_transfer",
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
        }
      } else {
        // Enabled chain with no usable human steps. AI-only chains aren't
        // supported (the product flow always rings a human first, then the AI
        // takes over on no-answer), so make the misconfiguration observable
        // instead of silently honoring `enabled` — then fall through to the
        // normal voice path.
        console.warn("handoff: enabled chain has no usable steps; falling through", {
          businessId,
          from: fromE164Informational,
          has_ai_takeover: Boolean(ctx.ai_takeover)
        });
        await telemetryRecord(supabase, "voice_handoff_failed", {
          business_id: businessId,
          call_control_id: callControlId,
          stage: "no_steps"
        });
      }
    }
  }

  // Per-caller warm-transfer rules (§voice_caller_transfer_rules). Certain
  // inbound numbers (e.g. Clever's live-transfer line) should bypass the AI
  // bridge entirely and connect straight to a human. Runs BEFORE the kill
  // switch / reserve / Stripe / bridge checks so it never consumes concurrency
  // or bills minutes. Matched on the (normalized) caller id; a missing/garbled
  // `from` simply can't match a rule and falls through to the normal path.
  if (fromE164Informational) {
    const { data: ruleRow, error: ruleErr } = await supabase
      .from("voice_caller_transfer_rules")
      .select("to_e164, whisper")
      .eq("business_id", businessId)
      .eq("from_e164", fromE164Informational)
      .maybeSingle();
    if (ruleErr) {
      // A rules lookup failure must not strand the caller — log and fall through
      // to the normal (AI) path rather than dropping the call.
      console.error("voice_caller_transfer_rules", ruleErr);
    }
    const rule = ruleRow as { to_e164?: string; whisper?: string | null } | null;
    if (rule?.to_e164) {
      const whisper = (rule.whisper ?? "").trim();
      // A warm transfer bridges an *answered* leg. Answer first and gate the
      // whisper + transfer on it — transferring an unanswered call is rejected
      // by Telnyx and strands the caller on dead air. (answerThenSpeak swallows
      // the answer result, so we answer explicitly here to act on a failure.)
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
          payload: { call_control_id: callControlId, http_status: ans.status, to: rule.to_e164 }
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
      const transferRes = await telnyxTransferCall(apiKey, callControlId, rule.to_e164);
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
          payload: { call_control_id: callControlId, http_status: transferRes.status, to: rule.to_e164 }
        });
        // The call is answered but the bridge was refused; hang up cleanly so the
        // caller isn't stranded on silent audio.
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
        message: `Warm-transferred caller ${fromE164Informational} to ${rule.to_e164} (per-caller rule)`,
        payload: { call_control_id: callControlId, from: fromE164Informational, to: rule.to_e164 }
      });
      return new Response(JSON.stringify({ ok: true, path: "caller_transfer" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // Kill switch + Safe Mode gate (§CustomerChannelGate).
  // Runs BEFORE reserve/Stripe/bridge checks so paused + forwarding calls never
  // consume concurrency or bill minutes. Safe Mode answers + speaks, then
  // transfers to the owner cell; kill switch answers + speaks, then hangs up
  // (via Telnyx's natural post-speak termination). We do not reserve capacity
  // on either branch.
  const { data: gateBizRow } = await supabase
    .from("businesses")
    .select("is_paused, customer_channels_enabled")
    .eq("id", businessId)
    .maybeSingle();
  const gateBiz = gateBizRow as
    | { is_paused?: boolean; customer_channels_enabled?: boolean }
    | null;

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
      await answerThenSpeak(apiKey, callControlId, VOICE_MSG_PAUSED);
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
      await answerThenSpeak(apiKey, callControlId, VOICE_MSG_SAFE_MODE_CONNECTING);
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
      const transferRes = await telnyxTransferCall(
        apiKey,
        callControlId,
        gate.forwardToE164
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
          VOICE_MSG_SAFE_MODE_FORWARD_FAILED
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
        // so we can't reuse 2500ms here — the caller would hear a truncated
        // "We're sorry, we could not con—" and then silence. Tied to the
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
      await answerThenSpeak(apiKey, callControlId, VOICE_MSG_CONCURRENT_LIMIT);
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
    } else if (reason === "quota_exhausted") {
      await answerThenSpeak(apiKey, callControlId, VOICE_MSG_QUOTA_EXHAUSTED);
      await systemLog(supabase, {
        businessId,
        source: "voice",
        level: "warn",
        event: "voice_call_blocked",
        message: `Inbound call refused: ${reason}`,
        payload: { call_control_id: callControlId, reason }
      });
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
      await answerThenSpeak(apiKey, callControlId, VOICE_MSG_SYSTEM_ERROR);
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
  // v2: the caller number is part of the signed canonical so the bridge can
  // trust it for staff detection + customer-memory recognition (issue #268).
  // Empty string when Telnyx gave no caller id — still signed so the bridge's
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
    v: "2",
    call_control_id: callControlId,
    business_id: businessId,
    to_e164: toE164,
    exp: String(exp),
    nonce,
    mac
  });
  // Caller number, transported as `from_e164_info` (unchanged param name) but
  // now SIGNED in the v2 canonical above — the bridge only trusts it (for staff
  // persona + memory recognition) when the v2 mac verifies. Set it whenever the
  // signed value is non-empty so the param round-trips into the canonical the
  // bridge rebuilds.
  if (signedFromE164) {
    qs.set("from_e164_info", signedFromE164);
  }
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
    await systemLog(supabase, {
      businessId,
      source: "voice",
      level: "error",
      event: "voice_answer_failed",
      message: `Telnyx answer failed (HTTP ${answerRes.status}): ${errText.slice(0, 300)}`,
      payload: { call_control_id: callControlId, http_status: answerRes.status }
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
