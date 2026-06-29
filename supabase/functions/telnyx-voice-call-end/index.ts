/**
 * Telnyx call hangup / end → record telnyx_ended_at for §9.1 settlement (signal1 of 2).
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { header, verifyTelnyxWebhook } from "../_shared/telnyx_webhook.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import {
  readTelnyxWebhookRateLimits,
  telnyxWebhookClientIp,
  telnyxWebhookRateAllow
} from "../_shared/telnyx_edge_guard.ts";
import {
  telnyxHangupCall,
  telnyxSendDtmf,
  telnyxStreamingStart,
  telnyxTransferCall
} from "../_shared/telnyx_call_actions.ts";
import {
  encodeHandoffClientState,
  type HandoffContext,
  parseHandoffClientState,
  planHandoffAdvance
} from "../_shared/voice_handoff.ts";
import { signStreamUrlMac, type StreamPayloadV2 } from "../_shared/stream_url.ts";
import { reserveVoiceBudget } from "../_shared/voice_reserve.ts";
import { parseOutboundClientState } from "../_shared/voice_outbound.ts";

const MAX_BODY = 256 * 1024;

/** Hangup / ended only — avoid `call.cost` (may fire multiple times or off teardown timing). */
const END_EVENTS = new Set(["call.hangup", "call.ended"]);

// ---------------------------------------------------------------------------
// Warm-handoff chain lifecycle (HomeLight live transfer).
//
// The chain is STARTED in telnyx-voice-inbound on call.initiated (answer +
// transfer to the first step). It is ADVANCED here because the voice dispatcher
// routes call.bridged + call.hangup to this function. We advance on the
// transfer legs' no-answer hangups, mark the session bridged when a human
// answers, and run the AI takeover when every human step is missed.
// ---------------------------------------------------------------------------

function jsonOk(path: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: true, path, ...extra }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

type HandoffDeps = {
  supabase: SupabaseClient<any, any, any>;
  apiKey: string;
  streamSecret: string;
  defaultBridgeOrigin: string;
  /** STRIPE_SECRET_KEY for the system-level voice budget gate (AI takeover). */
  stripeSecret: string;
};

function envVoiceAiStreamEnabled(): boolean {
  const v = (Deno.env.get("VOICE_AI_STREAM_ENABLED") ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

/**
 * Resolve the bridge media target (origin + path) for an AI takeover, gated on
 * a fresh bridge heartbeat. Returns null when AI streaming is disabled, the
 * bridge is unhealthy, or no origin is configured — the caller then aborts the
 * takeover instead of connecting the client to dead air.
 */
async function resolveBridgeTarget(
  deps: HandoffDeps,
  businessId: string,
  toE164: string
): Promise<{ origin: string; path: string } | null> {
  if (!envVoiceAiStreamEnabled()) {
    console.warn("handoff: AI stream disabled by flag; skipping takeover");
    return null;
  }
  // Without the signing secret attachAiStream would mint a stream URL with an
  // empty/invalid MAC; Telnyx streaming_start would still return 200 but the VPS
  // bridge rejects the WebSocket, leaving the connected seller in silence with no
  // cleanup. Gate the takeover here (before any DTMF) so the caller aborts and
  // ends the call cleanly instead.
  if (!deps.streamSecret) {
    console.error("handoff: STREAM_URL_SIGNING_SECRET missing; cannot AI-takeover", { businessId });
    return null;
  }
  const { supabase, defaultBridgeOrigin } = deps;
  const [{ data: route }, { data: settings }] = await Promise.all([
    supabase
      .from("telnyx_voice_routes")
      .select("media_wss_origin, media_path")
      .eq("to_e164", toE164)
      .maybeSingle(),
    supabase
      .from("business_telnyx_settings")
      .select("bridge_last_heartbeat_at, bridge_media_wss_origin, bridge_media_path")
      .eq("business_id", businessId)
      .maybeSingle()
  ]);

  const heartbeatTtlSec = (() => {
    const raw = Number(Deno.env.get("BRIDGE_HEARTBEAT_TTL_SEC") ?? "150");
    return Number.isFinite(raw) && raw >= 60 ? Math.floor(raw) : 150;
  })();
  const hb = settings?.bridge_last_heartbeat_at
    ? new Date(settings.bridge_last_heartbeat_at as string).getTime()
    : 0;
  if (!hb || Date.now() - hb > heartbeatTtlSec * 1000) {
    console.error("handoff: bridge down, cannot AI-takeover", { businessId });
    return null;
  }

  const origin =
    (route?.media_wss_origin as string | null) ??
    (settings?.bridge_media_wss_origin as string | null) ??
    defaultBridgeOrigin;
  if (!origin) {
    console.error("handoff: no bridge origin for AI-takeover", { businessId });
    return null;
  }
  const pathRaw =
    (route?.media_path as string | null) ??
    (settings?.bridge_media_path as string | null) ??
    "/voice/stream";
  const pathTrimmed = pathRaw.trim().replace(/\/+$/, "") || "/voice/stream";
  const path = pathTrimmed.startsWith("/") ? pathTrimmed : `/${pathTrimmed}`;
  return { origin, path };
}

/**
 * Mint a signed v2 media-stream URL and attach the Gemini bridge to the
 * already-answered A-leg via streaming_start. Mirrors the URL signing the main
 * inbound path does at answer time. Unlike the main path this does NOT
 * reserve/bill — the warm-handoff fallback is unmetered like the per-caller
 * transfer rules (it only runs when both humans miss a HomeLight transfer).
 */
async function attachAiStream(
  deps: HandoffDeps,
  args: {
    businessId: string;
    callControlId: string;
    toE164: string;
    fromE164: string;
    origin: string;
    path: string;
  }
): Promise<boolean> {
  const { supabase, apiKey, streamSecret } = deps;
  const exp = Math.floor(Date.now() / 1000) + 120;
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const streamPayload: StreamPayloadV2 = {
    v: 2,
    call_control_id: args.callControlId,
    business_id: args.businessId,
    to_e164: args.toE164,
    from_e164: args.fromE164,
    exp,
    nonce
  };
  const mac = await signStreamUrlMac(streamPayload, streamSecret);
  const expiresAt = new Date((exp + 60) * 1000).toISOString();
  const { error: nonceErr } = await supabase
    .from("stream_url_nonces")
    .insert({ nonce, expires_at: expiresAt });
  if (nonceErr) {
    console.error("handoff: nonce insert failed", nonceErr);
    return false;
  }

  const qs = new URLSearchParams({
    v: "2",
    call_control_id: args.callControlId,
    business_id: args.businessId,
    to_e164: args.toE164,
    exp: String(exp),
    nonce,
    mac
  });
  if (args.fromE164) qs.set("from_e164_info", args.fromE164);
  const streamUrl = `${args.origin.replace(/\/$/, "")}${args.path}?${qs.toString()}`
    .replace(/^http:/i, "ws:")
    .replace(/^https:/i, "wss:");

  const res = await telnyxStreamingStart(apiKey, args.callControlId, { streamUrl });
  if (!res.ok) {
    console.error("handoff: streaming_start failed", res.status, (await res.text()).slice(0, 300));
    return false;
  }
  return true;
}

/**
 * Outbound origination: a `call.answered` for an AiFlow-placed call (vob
 * client_state) means the callee picked up. telnyx-voice-originate reserves
 * budget and only then writes an `ai_intake` voice_handoff_sessions row, so that
 * row is the single gate: present+ai_intake ⇒ budgeted and configured ⇒ attach
 * the Gemini bridge (streaming_start) and flip the reservation to active;
 * anything else ⇒ hang up (never bridge an unconfirmed/refused/aborted leg).
 * Inbound answers carry no vob state and are ignored. Always returns a 200
 * Response (Telnyx must not retry a delivered webhook).
 */
async function handleOutboundAnswered(
  deps: HandoffDeps,
  payload: Record<string, unknown>
): Promise<Response> {
  const parsed = parseOutboundClientState(payload["client_state"] as string | undefined);
  if (!parsed) return jsonOk("ignored_inbound_answer");

  const { supabase, apiKey } = deps;
  const callControlId = String(payload["call_control_id"] ?? "");
  if (!callControlId) return jsonOk("outbound_no_call_control_id");
  const businessId = parsed.businessId;

  // Telnyx has already moved this leg to `answered`, so every bail-out below
  // must hang the leg up — otherwise the callee sits connected to silence with
  // no cleanup. The one exception is a missing TELNYX_API_KEY, where we have no
  // way to issue the hangup at all.
  if (!apiKey) {
    console.error("outbound: TELNYX_API_KEY missing; cannot attach or hang up", { callControlId });
    return jsonOk("outbound_no_api_key");
  }
  // Tear down a leg we won't bridge: release any reservation origination may have
  // taken (idempotent — a no-op if none exists, and the RPC defensively refuses
  // once a stream has attached) so a refused/aborted/raced leg never holds a
  // concurrency slot until the stale-settlement sweep, then hang up.
  const hangUpAnd = async (path: string, extra: Record<string, unknown> = {}): Promise<Response> => {
    const { error: relErr } = await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    if (relErr) console.error(`outbound: release (${path}) failed`, relErr);
    try {
      await telnyxHangupCall(apiKey, callControlId);
    } catch (e) {
      console.error(`outbound: hangup (${path}) failed`, e);
    }
    return jsonOk(path, extra);
  };

  // On an outbound leg, `to` is the callee we dialed and `from` is the business
  // DID we presented. Mirror inbound's signed-URL semantics: to_e164 = business
  // DID (route key), from_e164 = the remote party so the bridge recognizes them.
  const ourDid = String(payload["from"] ?? "").trim();
  const callee = String(payload["to"] ?? "").trim();
  if (!ourDid) {
    console.error("outbound: answered payload missing `from`; hanging up", { callControlId });
    return hangUpAnd("outbound_missing_from");
  }

  // The `ai_intake` session is the SINGLE authoritative gate. telnyx-voice-
  // originate writes it ONLY after a successful budget reservation, so its
  // presence proves the leg is both budgeted and configured. Anything else —
  // terminal `done`, or another business — means we must NOT bridge: doing so
  // could meter a call the UI already refused, or attach AI media to an aborted
  // leg. (Choosing "hang up when unconfirmed" over "reserve here" keeps budget
  // enforcement authoritative: a refused call can never proceed behind the UI's
  // back.) A *missing* row is the benign race where origination has reserved but
  // its session upsert (tens of ms later) hasn't landed when a very fast answer
  // arrives — retry briefly so we don't drop an otherwise-valid call before
  // concluding the leg is unconfirmed.
  let sess: { status?: string; business_id?: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: sessRow, error: sessErr } = await supabase
      .from("voice_handoff_sessions")
      .select("status, business_id")
      .eq("call_control_id", callControlId)
      .maybeSingle();
    if (sessErr) {
      console.error("outbound: session lookup failed; hanging up", sessErr);
      return hangUpAnd("outbound_session_lookup_error");
    }
    sess = sessRow as { status?: string; business_id?: string } | null;
    if (sess) break;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
  }
  if (!sess || sess.business_id !== businessId || sess.status !== "ai_intake") {
    console.warn("outbound: no active intake session for answered leg; hanging up", {
      callControlId,
      status: sess?.status ?? null
    });
    await telemetryRecord(supabase, "voice_outbound_answer_no_active_session", {
      business_id: businessId,
      call_control_id: callControlId,
      status: sess?.status ?? null
    });
    return hangUpAnd("outbound_no_active_session", { status: sess?.status ?? null });
  }

  // Idempotent: a retried call.answered after we already attached is a no-op.
  // (We don't re-read for budget — the ai_intake session above already proves
  // origination reserved this leg.)
  const { data: resvRow } = await supabase
    .from("voice_reservations")
    .select("answer_issued_at")
    .eq("call_control_id", callControlId)
    .maybeSingle();
  if ((resvRow as { answer_issued_at?: string | null } | null)?.answer_issued_at) {
    return jsonOk("outbound_already_attached");
  }

  const target = await resolveBridgeTarget(deps, businessId, ourDid);
  if (!target) {
    // Bridge down / streaming disabled / no origin → release the hold and hang
    // up cleanly so the callee isn't left on a silent line.
    const { error: relErr } = await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    if (relErr) console.error("outbound: release on bridge-unavailable failed", relErr);
    try {
      await telnyxHangupCall(apiKey, callControlId);
    } catch (e) {
      console.error("outbound: hangup (bridge unavailable) failed", e);
    }
    await telemetryRecord(supabase, "voice_outbound_bridge_unavailable", {
      business_id: businessId,
      call_control_id: callControlId
    });
    return jsonOk("outbound_bridge_unavailable");
  }

  const ok = await attachAiStream(deps, {
    businessId,
    callControlId,
    toE164: ourDid,
    fromE164: callee,
    origin: target.origin,
    path: target.path
  });
  if (!ok) {
    const { error: relErr } = await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    if (relErr) console.error("outbound: release on attach-fail failed", relErr);
    try {
      await telnyxHangupCall(apiKey, callControlId);
    } catch (e) {
      console.error("outbound: hangup (attach failed) failed", e);
    }
    await telemetryRecord(supabase, "voice_outbound_attach_failed", {
      business_id: businessId,
      call_control_id: callControlId
    });
    return jsonOk("outbound_attach_failed");
  }

  // Stream attached → flip pending_answer → active so settlement bills the media
  // minutes (signal 1 of 2 is the later call.hangup). Mirror the inbound path:
  // a failed or not-ok mark is a HARD failure — return 500 so Telnyx retries the
  // webhook rather than leaving a live stream on a reservation stuck in
  // pending_answer (which would weaken billing/concurrency accounting).
  const { error: markErr, data: markData } = await supabase.rpc("voice_mark_answer_issued", {
    p_call_control_id: callControlId
  });
  if (markErr) {
    console.error("outbound: voice_mark_answer_issued rpc error", markErr);
    await telemetryRecord(supabase, "voice_mark_answer_issued_fail", {
      business_id: businessId,
      call_control_id: callControlId,
      transport: "rpc_error"
    });
    return new Response(JSON.stringify({ ok: false, error: "mark_answer_issued" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  const mark = markData as { ok?: boolean; reason?: string } | null;
  if (!mark || mark.ok !== true) {
    console.error("outbound: voice_mark_answer_issued not ok", markData);
    await telemetryRecord(supabase, "voice_mark_answer_issued_fail", {
      business_id: businessId,
      call_control_id: callControlId,
      reason: mark?.reason ?? "not_ok"
    });
    return new Response(JSON.stringify({ ok: false, error: "mark_answer_issued", detail: mark?.reason }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  await telemetryRecord(supabase, "voice_outbound_stream_answered", {
    business_id: businessId,
    call_control_id: callControlId
  });
  return jsonOk("outbound_answered");
}

type HandoffSession = {
  call_control_id: string;
  business_id: string;
  from_e164: string;
  status: string;
  current_step: number;
  context: HandoffContext;
};

/**
 * Atomically claim an advancement so concurrent no-answer hangups can't
 * double-act. Returns true only when this caller won the race (a row matched and
 * updated). A real Supabase error is NOT a lost race — it throws so the caller
 * ends the call cleanly instead of silently stalling on `handoff_already_advanced`.
 */
async function claimStep(
  deps: HandoffDeps,
  aLeg: string,
  failedStep: number,
  patch: Record<string, unknown>
): Promise<boolean> {
  const { data, error } = await deps.supabase
    .from("voice_handoff_sessions")
    .update(patch)
    .eq("call_control_id", aLeg)
    .eq("status", "ringing")
    .eq("current_step", failedStep)
    .select("call_control_id");
  if (error) {
    console.error("handoff: claimStep update failed", error);
    throw new Error(`claimStep failed: ${error.message}`);
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * Terminal cleanup for a handoff that can't continue: mark the session done and
 * hang up the inbound A-leg so the caller is never stranded on an answered leg.
 * Both steps swallow their own errors — this is already the failure path.
 */
async function endHandoff(deps: HandoffDeps, aLeg: string): Promise<void> {
  // Release any voice budget reserved for an AI takeover that never reached the
  // bridge. endHandoff marks the session `done` before the self-initiated
  // hangup, so the A-leg hangup webhook can't recognize it as `ai_intake` and
  // settle/release it — without this the reservation would sit in
  // `pending_answer` holding a concurrency slot until a maintenance sweep. The
  // RPC is a no-op for the pre-reserve transfer paths and defensively refuses to
  // release once the bridge has attached, so it is always safe here.
  try {
    const { error } = await deps.supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: aLeg
    });
    if (error) console.error("handoff: release reservation failed", error);
  } catch (e) {
    console.error("handoff: release reservation threw", e);
  }
  try {
    await deps.supabase
      .from("voice_handoff_sessions")
      .update({ status: "done" })
      .eq("call_control_id", aLeg);
  } catch (e) {
    console.error("handoff: mark done failed", e);
  }
  try {
    await telnyxHangupCall(deps.apiKey, aLeg);
  } catch (e) {
    console.error("handoff: hangup failed", e);
  }
}

/** Advance a handoff session after the current step rang out with no answer. */
async function advanceHandoff(deps: HandoffDeps, sess: HandoffSession): Promise<Response> {
  const { apiKey } = deps;
  const aLeg = sess.call_control_id;
  const ctx = sess.context;
  const failedStep = sess.current_step;

  // Every advancement action (transfer / DTMF / streaming_start / hangup) needs
  // the Telnyx API key. telnyx-voice-call-end historically ran settlement-only,
  // where the key was optional — but a handoff session can't proceed without it.
  // Make the misconfiguration loud (telemetry + log) instead of silently
  // stalling the chain with the inbound leg still up.
  if (!apiKey) {
    console.error("handoff: TELNYX_API_KEY missing; cannot advance chain", { call: aLeg });
    await telemetryRecord(deps.supabase, "voice_handoff_failed", {
      business_id: sess.business_id,
      call_control_id: aLeg,
      stage: "missing_api_key"
    });
    return jsonOk("handoff_no_api_key");
  }
  const plan = planHandoffAdvance({
    steps: ctx.steps ?? [],
    failedStep,
    hasAiTakeover: Boolean(ctx.ai_takeover)
  });

  // Outer safety net: a claimStep DB error (now thrown, not swallowed) or any
  // other unexpected failure must end the call cleanly rather than 500 the
  // webhook and leave the caller on the answered inbound leg.
  try {
  if (plan.kind === "transfer") {
    // Atomic claim: only the first concurrent hangup advances from this step.
    if (!(await claimStep(deps, aLeg, failedStep, { current_step: plan.step }))) {
      return jsonOk("handoff_already_advanced");
    }
    // The claim already advanced current_step, so a thrown network error (not
    // just a non-OK status) would otherwise strand the caller: retried hangups
    // hit handoff_stale_step and nothing rings the next target. Wrap the Telnyx
    // call so any failure ends the call cleanly instead.
    try {
      const tf = await telnyxTransferCall(apiKey, aLeg, plan.toE164, {
        timeoutSecs: plan.ringSecs,
        clientState: encodeHandoffClientState(aLeg, plan.step)
      });
      if (!tf.ok) {
        console.error("handoff: advance transfer failed", tf.status, (await tf.text()).slice(0, 300));
        await endHandoff(deps, aLeg);
        return jsonOk("handoff_advance_failed");
      }
      return jsonOk("handoff_advance", { step: plan.step });
    } catch (err) {
      console.error("handoff: advance transfer threw", err);
      await endHandoff(deps, aLeg);
      return jsonOk("handoff_advance_failed");
    }
  }

  if (plan.kind === "ai_takeover" && ctx.ai_takeover) {
    // Resolve the bridge target (and health) BEFORE pressing 1, so we never
    // connect the live client to a dead bridge.
    const target = await resolveBridgeTarget(deps, sess.business_id, ctx.to_e164);
    if (!target) {
      if (await claimStep(deps, aLeg, failedStep, { status: "done" })) {
        await telnyxHangupCall(apiKey, aLeg);
      }
      return jsonOk("handoff_ai_takeover_unavailable");
    }
    // Atomic claim to ai_intake so the bridge picks the intake persona; if we
    // lose the race, do nothing (no DTMF, no stream).
    if (!(await claimStep(deps, aLeg, failedStep, { status: "ai_intake" }))) {
      return jsonOk("handoff_already_advanced");
    }
    // Past the claim the session is committed to ai_intake; any thrown error
    // below must end the call cleanly (retried hangups would see
    // handoff_not_ringing) rather than leave the seller on a silent leg.
    try {
      // System-level voice metering: the AI takeover spends Gemini minutes, so
      // it goes through the SAME budget gate as the inbound receptionist. No
      // budget (quota/concurrency) ⇒ never press 1 / attach the bridge; end the
      // call cleanly. Settlement of this reservation happens on the A-leg hangup.
      const reserve = await reserveVoiceBudget(deps.supabase, {
        businessId: sess.business_id,
        callControlId: aLeg,
        stripeSecret: deps.stripeSecret
      });
      if (!reserve.ok) {
        console.warn("handoff: AI takeover blocked, no voice budget", {
          call: aLeg,
          reason: reserve.reason
        });
        await telemetryRecord(deps.supabase, "voice_handoff_ai_blocked", {
          business_id: sess.business_id,
          call_control_id: aLeg,
          reason: reserve.reason
        });
        await endHandoff(deps, aLeg);
        return jsonOk("handoff_ai_no_budget", { reason: reserve.reason });
      }
      // Press "1" FIRST so HomeLight connects the live client, THEN attach the
      // bridge — otherwise the AI greeting plays to the IVR / dead air. If the
      // DTMF fails the client is never bridged, so abort rather than run the
      // intake assistant against hold music (and text Amy a phantom lead).
      const dt = await telnyxSendDtmf(apiKey, aLeg, "1");
      if (!dt.ok) {
        console.error("handoff: send_dtmf failed", dt.status, (await dt.text()).slice(0, 300));
        await endHandoff(deps, aLeg);
        return jsonOk("handoff_dtmf_failed");
      }
      const ok = await attachAiStream(deps, {
        businessId: sess.business_id,
        callControlId: aLeg,
        toE164: ctx.to_e164,
        fromE164: sess.from_e164,
        origin: target.origin,
        path: target.path
      });
      if (!ok) {
        await endHandoff(deps, aLeg);
        return jsonOk("handoff_ai_takeover_unavailable");
      }
      return jsonOk("handoff_ai_takeover");
    } catch (err) {
      console.error("handoff: ai takeover threw", err);
      await endHandoff(deps, aLeg);
      return jsonOk("handoff_ai_takeover_unavailable");
    }
  }

  // No more steps and no AI takeover: hang up cleanly.
  if (await claimStep(deps, aLeg, failedStep, { status: "done" })) {
    await telnyxHangupCall(apiKey, aLeg);
  }
  return jsonOk("handoff_exhausted");
  } catch (err) {
    console.error("handoff: advance threw", err);
    await endHandoff(deps, aLeg);
    return jsonOk("handoff_error");
  }
}

/**
 * Handle Telnyx call.bridged / call.hangup for warm-handoff sessions. Returns
 * `handled:false` for events that belong to a normal (non-handoff) call so the
 * caller can fall through to settlement.
 */
async function handleHandoffLifecycle(
  deps: HandoffDeps,
  eventType: string,
  payload: Record<string, unknown>
): Promise<{ handled: boolean; response: Response }> {
  const { supabase } = deps;
  const callControlId = String(payload["call_control_id"] ?? "");
  const parsed = parseHandoffClientState(payload["client_state"] as string | undefined);

  if (eventType === "call.bridged") {
    // A human answered the step leg → mark bridged so a later hangup can't
    // advance the chain. No client_state ⇒ not a handoff leg.
    if (!parsed) return { handled: false, response: jsonOk("ignored_bridged") };
    // Match the exact ringing step encoded in client_state. A delayed bridged
    // webhook from an EARLIER step's leg must not mark the session bridged while
    // a LATER step is ringing — that would freeze the chain (subsequent
    // no-answer hangups would be ignored as "not ringing").
    await supabase
      .from("voice_handoff_sessions")
      .update({ status: "bridged" })
      .eq("call_control_id", parsed.aLegCallId)
      .eq("status", "ringing")
      .eq("current_step", parsed.step);
    return { handled: true, response: jsonOk("handoff_bridged") };
  }

  // call.hangup — outbound AiFlow leg. Unlike inbound (which always answers and
  // engages the AI within ms), an outbound call commonly rings out unanswered.
  // call.answered then never runs, so its pre-answer reservation would sit in
  // `pending_answer` holding a concurrency slot until the stale-settlement sweep.
  // Release it now when the leg ended without ever attaching the stream
  // (answer_issued_at is null). If it WAS answered, fall through to normal
  // settlement so the media minutes are billed.
  const outbound = parseOutboundClientState(payload["client_state"] as string | undefined);
  if (outbound && callControlId) {
    await supabase
      .from("voice_handoff_sessions")
      .update({ status: "done" })
      .eq("call_control_id", callControlId);
    const { data: resvRow } = await supabase
      .from("voice_reservations")
      .select("answer_issued_at")
      .eq("call_control_id", callControlId)
      .maybeSingle();
    if (!(resvRow as { answer_issued_at?: string | null } | null)?.answer_issued_at) {
      const { error: relErr } = await supabase.rpc("voice_release_reservation_on_answer_fail", {
        p_call_control_id: callControlId
      });
      if (relErr) console.error("outbound: release on no-answer hangup failed", relErr);
      return { handled: true, response: jsonOk("outbound_no_answer_released") };
    }
    // Answered → let settlement bill the media (do not short-circuit).
    return { handled: false, response: jsonOk("outbound_answered_hangup") };
  }

  // call.hangup
  if (parsed) {
    const { data: sessRow } = await supabase
      .from("voice_handoff_sessions")
      .select("call_control_id, business_id, from_e164, status, current_step, context")
      .eq("call_control_id", parsed.aLegCallId)
      .maybeSingle();
    const sess = sessRow as HandoffSession | null;
    if (!sess) return { handled: true, response: jsonOk("handoff_no_session") };
    if (sess.status !== "ringing") {
      return { handled: true, response: jsonOk("handoff_not_ringing") };
    }
    if (sess.current_step !== parsed.step) {
      return { handled: true, response: jsonOk("handoff_stale_step") };
    }
    // Defence in depth in case call.bridged was not delivered: a normal_clearing
    // hangup means the human answered and the call completed — don't advance.
    const cause = String(payload["hangup_cause"] ?? "").toLowerCase();
    if (cause === "normal_clearing") {
      await supabase
        .from("voice_handoff_sessions")
        .update({ status: "done" })
        .eq("call_control_id", parsed.aLegCallId)
        .eq("status", "ringing");
      return { handled: true, response: jsonOk("handoff_answered_hangup") };
    }
    return { handled: true, response: await advanceHandoff(deps, sess) };
  }

  // No client_state: the inbound A-leg may be hanging up. If a session is keyed
  // by this call id, mark it terminal so nothing advances afterward. Otherwise
  // it's a normal call → let settlement handle it.
  if (!callControlId) return { handled: false, response: jsonOk("ignored_hangup") };
  const { data: sessRow } = await supabase
    .from("voice_handoff_sessions")
    .select("call_control_id, status")
    .eq("call_control_id", callControlId)
    .maybeSingle();
  if (!sessRow) return { handled: false, response: jsonOk("ignored_hangup") };
  const priorStatus = String((sessRow as { status?: string }).status ?? "");
  await supabase
    .from("voice_handoff_sessions")
    .update({ status: "done" })
    .eq("call_control_id", callControlId);
  // An AI takeover reserved voice budget for this A-leg, so its hangup MUST flow
  // into settlement (signal 1 of 2) to bill the Gemini minutes. Human-only
  // handoffs never reserved, so settlement is a no-op for them — short-circuit
  // to avoid an extra "unknown_call" round-trip.
  if (priorStatus === "ai_intake") {
    return { handled: false, response: jsonOk("handoff_session_closed") };
  }
  return { handled: true, response: jsonOk("handoff_session_closed") };
}

function parseCallDurationSeconds(payload: Record<string, unknown>): number | null {
  const v = payload["call_duration"];
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
    return Math.floor(v);
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return null;
}

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
  // Optional (handoff chain only): not required for normal settlement, so a
  // missing value degrades the AI-takeover path rather than failing the webhook.
  const telnyxApiKey = Deno.env.get("TELNYX_API_KEY") ?? "";
  const streamSecret = Deno.env.get("STREAM_URL_SIGNING_SECRET") ?? "";
  const defaultBridgeOrigin = Deno.env.get("BRIDGE_MEDIA_WSS_ORIGIN") ?? "";
  const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

  const supabase = createClient(supabaseUrl, serviceKey);
  const handoffDeps: HandoffDeps = {
    supabase,
    apiKey: telnyxApiKey,
    streamSecret,
    defaultBridgeOrigin,
    stripeSecret
  };

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) {
    await telemetryRecord(supabase, "edge_webhook_rejected", {
      reason: "size",
      route: "telnyx_voice_call_end"
    });
    return new Response("Payload too large", { status: 413 });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) {
    await telemetryRecord(supabase, "edge_webhook_rejected", {
      reason: "size",
      route: "telnyx_voice_call_end"
    });
    return new Response("Payload too large", { status: 413 });
  }

  const clientIp = telnyxWebhookClientIp(req);
  const rate = await telnyxWebhookRateAllow(
    supabase,
    clientIp,
    "telnyx_voice_call_end",
    readTelnyxWebhookRateLimits((k) => Deno.env.get(k))
  );
  if (!rate.ok) {
    await telemetryRecord(supabase, "edge_webhook_rejected", {
      reason: "rate",
      route: "telnyx_voice_call_end",
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
      route: "telnyx_voice_call_end"
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
      route: "telnyx_voice_call_end",
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
  // Outbound origination: a callee answered an AiFlow-placed call. Attach the AI
  // bridge to the already-reserved leg. (Inbound answers carry no vob state and
  // are ignored inside the handler.)
  if (eventType === "call.answered") {
    return await handleOutboundAnswered(handoffDeps, data?.payload ?? {});
  }

  // Warm-handoff chain: advance on the transfer legs' bridged/hangup events.
  // Only handoff-related events are intercepted; normal calls fall through to
  // settlement below.
  if (eventType === "call.bridged" || eventType === "call.hangup") {
    const handoff = await handleHandoffLifecycle(handoffDeps, eventType, data?.payload ?? {});
    if (handoff.handled) return handoff.response;
  }

  if (!END_EVENTS.has(eventType)) {
    return new Response(JSON.stringify({ ok: true, skipped: eventType }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const payload = data?.payload ?? {};
  const callControlId = String(payload["call_control_id"] ?? "");
  if (!callControlId) {
    return new Response(JSON.stringify({ ok: true, skip: "no_call_control_id" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const { data: resv, error: resvErr } = await supabase
    .from("voice_reservations")
    .select("business_id, id")
    .eq("call_control_id", callControlId)
    .maybeSingle();

  if (resvErr) {
    console.error("voice_reservations", resvErr);
    return new Response("DB error", { status: 500 });
  }

  const businessId = resv?.business_id as string | undefined;
  if (!businessId) {
    return new Response(JSON.stringify({ ok: true, skip: "unknown_call" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const nowIso = new Date().toISOString();
  const reportedDurationSec = parseCallDurationSeconds(payload);
  const { data: existing, error: existingErr } = await supabase
    .from("voice_settlements")
    .select("call_control_id, first_signal_at, telnyx_reported_duration_seconds")
    .eq("call_control_id", callControlId)
    .maybeSingle();

  if (existingErr) {
    console.error("voice_settlements select", existingErr);
    return new Response("DB error", { status: 500 });
  }

  const existingRow = existing as {
    first_signal_at?: string;
    telnyx_reported_duration_seconds?: number | null;
  } | null;

  const firstAt = existingRow?.first_signal_at ?? nowIso;

  let mergedReported: number | undefined;
  if (reportedDurationSec != null) {
    const prev = existingRow?.telnyx_reported_duration_seconds;
    if (typeof prev === "number" && Number.isFinite(prev) && prev >= 0) {
      // Telnyx may emit multiple hangup/end events; take the minimum reported duration (conservative for metering).
      mergedReported = Math.min(prev, reportedDurationSec);
    } else {
      mergedReported = reportedDurationSec;
    }
  }

  const settlementRow: Record<string, unknown> = {
    call_control_id: callControlId,
    business_id: businessId,
    reservation_id: resv?.id ?? null,
    telnyx_ended_at: nowIso,
    first_signal_at: firstAt
  };
  if (mergedReported != null) {
    settlementRow.telnyx_reported_duration_seconds = mergedReported;
  }

  const { error: upsertErr } = await supabase.from("voice_settlements").upsert(settlementRow, {
    onConflict: "call_control_id"
  });

  if (upsertErr) {
    console.error("voice_settlements upsert", upsertErr);
    return new Response("Settlement write failed", { status: 500 });
  }

  const { error: finErr, data: fin } = await supabase.rpc("voice_try_finalize_settlement", {
    p_call_control_id: callControlId,
    p_allow_one_sided: false
  });
  if (finErr) {
    console.error("voice_try_finalize_settlement", finErr);
    return new Response("Finalize RPC failed", { status: 500 });
  }
  const finJson = fin as { ok?: boolean; billable_seconds?: number } | null;
  if (finJson?.ok === true && typeof finJson.billable_seconds === "number") {
    await telemetryRecord(supabase, "voice_call_settlement_finalized", {
      call_control_id: callControlId,
      billable_seconds: finJson.billable_seconds
    });
  }

  return new Response(JSON.stringify({ ok: true, call_control_id: callControlId, finalize: finJson }), {
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
