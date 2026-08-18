/**
 * Telnyx call hangup / end → record telnyx_ended_at for §9.1 settlement (signal1 of 2).
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.0";
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
  telnyxSpeak,
  telnyxStreamingStop,
  telnyxTransferCall
} from "../_shared/telnyx_call_actions.ts";
import {
  encodeHandoffClientState,
  type HandoffContext,
  parseHandoffClientState,
  planHandoffAdvance
} from "../_shared/voice_handoff.ts";
import { attachAiStream, resolveBridgeTarget } from "../_shared/voice_ai_attach.ts";
import { reserveVoiceBudget } from "../_shared/voice_reserve.ts";
import { smsTextUnits } from "../_shared/sms_text_units.ts";
import {
  smsDestinationCountry,
  smsDestinationMultiplier
} from "../_shared/sms_destination_rates.ts";
import { parseOutboundClientState } from "../_shared/voice_outbound.ts";
import {
  AMD_DETECTION_EVENTS,
  AMD_SCREENING_EVENTS,
  classifyAmdResult,
  classifyGreetingEvent,
  greetingImpliesMachine,
  isAmdEvent
} from "../_shared/voice_amd.ts";
import { CALL_REASON } from "../_shared/ai_flows/call_outcome_meta.ts";
import { parseReachClientState } from "../_shared/voice_reach.ts";
import {
  resumeFlowRunWithCallOutcome,
  type FlowRunLink
} from "../_shared/ai_flows/call_outcome.ts";
import {
  buildOwnerMessage,
  buildRecipientMessage,
  labelFor,
  normE164,
  parseWtClientState,
  recipientIsOwner,
  shouldNotifyOwner,
  type WtOutcome
} from "../_shared/warm_transfer_notify.ts";
import { telnyxSendSms } from "../_shared/telnyx_sms_compliance.ts";
import { starBlock } from "../_shared/star_block.ts";
import { sendCapAlertOnce, smsCapPeriodKey } from "../_shared/cap_alerts.ts";
import {
  recordForwardedCall,
  type ForwardedCallLogResult,
  type ForwardedCallOutcome
} from "../_shared/forwarded_call_log.ts";
import { sendMissedCallAutotext } from "../_shared/missed_call_autotext.ts";
import { maybeSendMissedCallSpikeAlert } from "../_shared/missed_call_spike.ts";
import { systemLog } from "../_shared/system_log.ts";
import { meterForwardedCallSeconds } from "../_shared/forwarded_call_meter.ts";
import { parseCallDurationSeconds } from "../_shared/telnyx_call_duration.ts";

const MAX_BODY = 256 * 1024;

/** Hangup / ended only, avoid `call.cost` (may fire multiple times or off teardown timing). */
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

// resolveBridgeTarget / attachAiStream moved to _shared/voice_ai_attach.ts when
// telnyx-voice-inbound needed the identical sequence for AI-first answering.

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
  // must hang the leg up, otherwise the callee sits connected to silence with
  // no cleanup. The one exception is a missing TELNYX_API_KEY, where we have no
  // way to issue the hangup at all.
  if (!apiKey) {
    console.error("outbound: TELNYX_API_KEY missing; cannot attach or hang up", { callControlId });
    return jsonOk("outbound_no_api_key");
  }
  // Tear down a leg we won't bridge: release any reservation origination may have
  // taken (idempotent, a no-op if none exists, and the RPC defensively refuses
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
  // presence proves the leg is both budgeted and configured. Anything else,
  // terminal `done`, or another business, means we must NOT bridge: doing so
  // could meter a call the UI already refused, or attach AI media to an aborted
  // leg. (Choosing "hang up when unconfirmed" over "reserve here" keeps budget
  // enforcement authoritative: a refused call can never proceed behind the UI's
  // back.) A *missing* row is the benign race where origination has reserved but
  // its session upsert (tens of ms later) hasn't landed when a very fast answer
  // arrives, retry briefly so we don't drop an otherwise-valid call before
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
  // (We don't re-read for budget, the ai_intake session above already proves
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
    path: target.path,
    translatorArmed: target.translatorArmed
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
  // a failed or not-ok mark is a HARD failure, return 500 so Telnyx retries the
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
 * updated). A real Supabase error is NOT a lost race, it throws so the caller
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
 * Both steps swallow their own errors, this is already the failure path.
 */
async function endHandoff(deps: HandoffDeps, aLeg: string): Promise<void> {
  // Release any voice budget reserved for an AI takeover that never reached the
  // bridge. endHandoff marks the session `done` before the self-initiated
  // hangup, so the A-leg hangup webhook can't recognize it as `ai_intake` and
  // settle/release it, without this the reservation would sit in
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
  // where the key was optional, but a handoff session can't proceed without it.
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
    // This human step rang out (we're advancing to the next one) → notify the
    // recipient (and owner) that they missed the transfer. Per-step dedup key so
    // each ringed-out step is texted exactly once.
    await sendWarmTransferNotifications(deps.supabase, deps.apiKey, {
      businessId: sess.business_id,
      callerE164: sess.from_e164 ?? "",
      recipientE164: ctx.steps?.[failedStep]?.to_e164 ?? "",
      outcome: "failed",
      dedupeKey: `hl:failed:${aLeg}:${failedStep}`,
      starFrame: ctx.star_alerts === true
    });
    // The claim already advanced current_step, so a thrown network error (not
    // just a non-OK status) would otherwise strand the caller: retried hangups
    // hit handoff_stale_step and nothing rings the next target. Wrap the Telnyx
    // call so any failure ends the call cleanly instead.
    try {
      const tf = await telnyxTransferCall(apiKey, aLeg, plan.toE164, {
        timeoutSecs: plan.ringSecs,
        // Same reason as the chain's first transfer: a voicemail answering
        // auto-bridges, and the machine verdict is what un-sticks the chain.
        answeringMachineDetection: "premium",
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
    // The last human step rang out without a connect → the AI now takes over.
    // Notify that step's recipient (and owner) of the miss. Per-step dedup key
    // (ctx.to_e164 is the business DID, not a person).
    await sendWarmTransferNotifications(deps.supabase, deps.apiKey, {
      businessId: sess.business_id,
      callerE164: sess.from_e164 ?? "",
      recipientE164: ctx.steps?.[failedStep]?.to_e164 ?? "",
      outcome: "failed",
      dedupeKey: `hl:failed:${aLeg}:${failedStep}`,
      starFrame: ctx.star_alerts === true
    });
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
      // bridge, otherwise the AI greeting plays to the IVR / dead air. If the
      // DTMF fails the client is never bridged, so abort rather than run the
      // intake assistant against hold music (and text Amy a phantom lead).
      //
      // SKIPPED when the AI-first path already accepted on this call (it stamps
      // accept_sent before falling back to the rings): the partner's IVR is long
      // past and the customer is already connected, so pressing again would send
      // a stray tone into a live conversation.
      if (ctx.ai_takeover?.accept_sent === true) {
        console.log("handoff: accept digits already sent by the AI-first path; not re-pressing", {
          call: aLeg
        });
      } else {
        const dt = await telnyxSendDtmf(apiKey, aLeg, "1");
        if (!dt.ok) {
          console.error("handoff: send_dtmf failed", dt.status, (await dt.text()).slice(0, 300));
          await endHandoff(deps, aLeg);
          return jsonOk("handoff_dtmf_failed");
        }
      }
      const ok = await attachAiStream(deps, {
        businessId: sess.business_id,
        callControlId: aLeg,
        toE164: ctx.to_e164,
        fromE164: sess.from_e164,
        origin: target.origin,
        path: target.path,
        translatorArmed: target.translatorArmed
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

  // No more steps and no AI takeover: the final human step rang out → notify
  // that recipient (and owner) of the miss (per-step dedup key; ctx.to_e164 is
  // the business DID, not a person), then hang up cleanly.
  await sendWarmTransferNotifications(deps.supabase, deps.apiKey, {
    businessId: sess.business_id,
    callerE164: sess.from_e164 ?? "",
    recipientE164: ctx.steps?.[failedStep]?.to_e164 ?? "",
    outcome: "failed",
    dedupeKey: `hl:failed:${aLeg}:${failedStep}`,
    starFrame: ctx.star_alerts === true
  });
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
/**
 * Answering-machine detection on an AiFlow-placed outbound call.
 *
 * Records the verdict on the session and, for a machine, hangs the leg up.
 * It does NOT resume the parked run itself: the hangup it triggers already
 * flows through the outbound path below, which reads the stamp and derives
 * the outcome. One writer, no race between this handler and the hangup.
 *
 * Only outbound AiFlow legs are touched (`vob:` client_state). An inbound
 * call with AMD configured on the connection is left entirely alone.
 */
async function handleMachineDetection(
  supabase: SupabaseClient,
  eventType: string,
  payload: Record<string, unknown>
): Promise<Response> {
  const callControlId = String(payload["call_control_id"] ?? "");
  if (!callControlId) return jsonOk("amd_no_leg");

  // A "reach a teammate" B leg: the verdict feeds the ladder's bridge gate.
  const reach = parseReachClientState(payload["client_state"] as string | undefined);
  if (reach) {
    return await handleReachAmd(supabase, eventType, payload, reach, callControlId);
  }

  // A warm-handoff transfer leg: a machine verdict un-sticks the chain.
  const handoff = parseHandoffClientState(payload["client_state"] as string | undefined);
  if (handoff) {
    return await handleHandoffAmd(supabase, eventType, payload, handoff, callControlId);
  }

  const outbound = parseOutboundClientState(payload["client_state"] as string | undefined);
  if (!outbound) {
    return jsonOk("amd_not_outbound");
  }

  // Apple call screening answered (premium_ios_call_screening_detection only).
  // NOT a verdict: a live person is deciding whether to take the call, and the
  // bridge's outbound persona answers the screening prompt with one
  // identification sentence. Recorded so the call page and the outcome
  // derivation can tell "screened" from plain dead air.
  if (AMD_SCREENING_EVENTS.has(eventType)) {
    await telemetryRecord(supabase, "voice_amd_screening", {
      call_control_id: callControlId,
      business_id: outbound.businessId,
      result: typeof payload["result"] === "string" ? payload["result"] : null
    });
    // Screening means a live person is deciding, and Telnyx's sequence fires
    // the provisional "machine" verdict BEFORE this event, clear it, or a
    // screened call the human answers would settle as no_answer and its
    // follow-up ladder would redial someone who already picked up.
    await clearProvisionalMachine(supabase, callControlId, { ios_screening: true });
    return jsonOk("amd_screening_noted");
  }
  // Greeting events: the outgoing "leave a message after the tone" has
  // finished, which is the only safe moment to start speaking. Two jobs now.
  //
  // 1. If the step configured a voicemail message, speak it (whether the
  //    verdict came from detection.ended earlier or from this beep).
  // 2. BACKSTOP, unchanged: Telnyx documents detection.ended as always
  //    preceding greeting.ended, but a beep is its own proof of a voicemail,
  //    and relying on that ordering is not worth re-introducing the exact bug
  //    this handler exists to prevent. A beep with no verdict recorded yet is
  //    treated as a machine; anything else is acknowledged and dropped.
  if (!AMD_DETECTION_EVENTS.has(eventType)) {
    // The iOS screening prompt finished WITHOUT an Apple tone or a beep: a
    // live person heard the caller's identification and is deciding (or about
    // to speak). The provisional machine stamp from detection.ended must not
    // survive this, or a screened call the human then answers would settle as
    // no_answer and its follow-up ladder would redial someone who picked up.
    // Never speak a voicemail script here and never hang up.
    // classifyGreetingEvent owns the subtlety (see its docstring): the same
    // `prompt_ended` result means "a person is screening" only when screening
    // actually announced itself, and otherwise means an ordinary voicemail
    // greeting just finished. Reading it as screening unconditionally
    // cancelled a correct machine verdict on a live call (Jennifer Kline,
    // 2026-08-17), so the decision now lives in one tested place.
    const already = await machineAlreadyStamped(supabase, callControlId);
    const greeting = classifyGreetingEvent(payload["result"], {
      machineStamped: already,
      screeningDetected: await iosScreeningDetected(supabase, callControlId)
    });
    if (greeting === "screening_person") {
      await clearProvisionalMachine(supabase, callControlId, {});
      return jsonOk("amd_screening_prompt_ended");
    }
    if (greeting === "noted") {
      return jsonOk("amd_greeting_noted");
    }
    const script = await voicemailScriptFor(supabase, callControlId);
    if (!already) {
      await telemetryRecord(supabase, "voice_amd_verdict", {
        call_control_id: callControlId,
        business_id: outbound.businessId,
        event_type: eventType,
        result: typeof payload["result"] === "string" ? payload["result"] : null,
        verdict: "machine_from_beep"
      });
      // No script: hang up now, exactly as before voicemails existed.
      if (!script) return await stampMachineAndHangUp(supabase, callControlId);
      // With a script the stamp still has to land before we speak, because the
      // hangup path reads it to decide the outcome is no_answer and not
      // "answered". stampMachine writes it without ending the leg.
      const stamped = await stampMachine(supabase, callControlId);
      if (!stamped) return jsonOk("amd_stamp_failed");
    }
    // Verdict already stamped and the greeting has now resolved. This is
    // where a script-less machine leg ends: the verdict handler defers its
    // hangup to here so a screened iPhone (whose "machine" is provisional)
    // is never cut before the screening events can arrive.
    if (!script) return await stampMachineAndHangUp(supabase, callControlId);
    return await speakVoicemail(supabase, callControlId, script);
  }

  const verdict = classifyAmdResult(payload["result"]);
  await telemetryRecord(supabase, "voice_amd_verdict", {
    call_control_id: callControlId,
    business_id: outbound.businessId,
    event_type: eventType,
    result: typeof payload["result"] === "string" ? payload["result"] : null,
    verdict
  });
  // A person, or a verdict Telnyx could not commit to (silence, fax tone,
  // not_sure). Carry on with the call: hanging up on a maybe-person to save a
  // few voice minutes is the wrong trade.
  if (verdict !== "machine") {
    return jsonOk(`amd_${verdict}`);
  }

  // A machine verdict is PROVISIONAL under premium_ios_call_screening_detection:
  // Telnyx's documented sequence fires detection.ended with "machine" FIRST
  // and only then listens for a screening prompt or Apple tone, so a screened
  // iPhone looks exactly like a voicemail at this moment. Acting on the
  // verdict here (hanging up, or silencing the assistant) would kill the
  // identification sentence that gets a screened call picked up. So: stamp
  // the verdict for outcome honesty, and defer every ACTION to the
  // resolution event. greeting.ended with a beep is a real voicemail (speak
  // the script, or hang up); call_screening.detected / prompt_ended is a
  // live person deciding (carry on, and the provisional stamp is cleared).
  // A voicemail on a script-less step now stays up through its greeting
  // (premium bounds that wait with its analysis window) instead of being cut
  // at the verdict; that costs a few billed seconds and buys every screened
  // iPhone.
  return (await stampMachine(supabase, callControlId))
    ? jsonOk("amd_machine_awaiting_resolution")
    : jsonOk("amd_stamp_failed");
}

/**
 * AMD verdict for a "reach a teammate" B leg.
 *
 * A teammate whose phone is off goes to carrier voicemail within a couple of
 * seconds, which ANSWERS the leg: the answered stamp lands and the ladder
 * would bridge the caller straight into that voicemail greeting. The ladder
 * therefore holds its bridge briefly (awaitReachAmdClearance on the bridge
 * side) and this handler writes what it is waiting for: the verdict, onto the
 * CALLER's session keyed by attempt, exactly where the answered stamp already
 * lives. A machine verdict also hangs the B leg up, so the ladder's next dial
 * is not racing a voicemail that is still recording silence.
 *
 * "unknown" is deliberately NOT written: the ladder's clearance cap decides,
 * and it fails open to bridging, the same treat-as-human bias every other AMD
 * consumer here has. A greeting event whose result is a BEEP counts as machine
 * evidence in its own right, exactly like the outbound path: relying on the
 * verdict always arriving first re-introduces the ordering dependency
 * voice_amd.ts exists to remove, and a beep-first voicemail would otherwise
 * fail open into the greeting. Other greeting/screening results are dropped.
 */
async function handleReachAmd(
  supabase: SupabaseClient,
  eventType: string,
  payload: Record<string, unknown>,
  reach: { businessId: string; aLegCallControlId: string; attempt: number },
  bLegCallControlId: string
): Promise<Response> {
  const isDetection = AMD_DETECTION_EVENTS.has(eventType);
  const beepMachine = !isDetection && greetingImpliesMachine(payload["result"]);
  if (!isDetection && !beepMachine) return jsonOk("amd_reach_ignored");
  const verdict = isDetection ? classifyAmdResult(payload["result"]) : "machine";
  await telemetryRecord(supabase, "voice_amd_verdict", {
    call_control_id: bLegCallControlId,
    business_id: reach.businessId,
    event_type: eventType,
    result: typeof payload["result"] === "string" ? payload["result"] : null,
    verdict,
    leg: "reach"
  });
  if (verdict === "unknown") return jsonOk("amd_reach_unknown");
  // Stale-attempt protection lives in the READER (readReachAmd ignores a
  // mismatched attempt), mirroring readReachOutcome, so a blind merge is safe
  // here: verdicts for a torn-down leg classify as unknown and never land.
  const { error } = await supabase.rpc("voice_session_context_merge", {
    p_call_control_id: reach.aLegCallControlId,
    p_patch: { reach_amd: { attempt: reach.attempt, verdict } }
  });
  if (error) {
    // The ladder's clearance cap still resolves the wait; losing the stamp
    // costs a slower bridge (or a bridged voicemail, the pre-AMD behavior).
    console.error("reach: amd stamp failed", error);
  }
  if (verdict === "machine") {
    // A LATE machine verdict can land after the clearance cap already failed
    // open and the ladder bridged this leg to the caller. Cutting a bridged
    // leg on a late verdict is the worse failure (the same principle as the
    // handoff freshness window): the verdict may be wrong, and the caller is
    // mid-conversation. The ladder stamps context.reach_bridged BEFORE it
    // issues the bridge command, so reading it here cannot miss a bridge that
    // is already in flight.
    const { data: sessRow } = await supabase
      .from("voice_handoff_sessions")
      .select("context")
      .eq("call_control_id", reach.aLegCallControlId)
      .maybeSingle();
    const bridgedAttempt = (
      (sessRow as { context?: { reach_bridged?: { attempt?: unknown } } } | null)?.context
        ?.reach_bridged ?? null
    )?.attempt;
    if (bridgedAttempt === reach.attempt) {
      return jsonOk("amd_reach_machine_after_bridge");
    }
    await telnyxHangupCall(Deno.env.get("TELNYX_API_KEY") ?? "", bLegCallControlId);
  }
  return jsonOk(`amd_reach_${verdict}`);
}

/**
 * Window inside which a machine verdict may yank a freshly BRIDGED handoff
 * transfer leg. The verdict fires seconds after a voicemail answers, so a
 * fresh bridge into a machine is un-stickable; past this window the far end
 * is far more likely a live human whose call must not be cut (a late or
 * redelivered verdict yanking a real conversation is the worse failure).
 */
const HANDOFF_AMD_YANK_WINDOW_MS = 15_000;

/**
 * AMD verdict for a warm-handoff transfer leg.
 *
 * A transfer auto-bridges the caller to whoever answers, and a step target
 * whose phone is off reaches carrier voicemail inside any ring window: the
 * caller lands in the teammate's voicemail greeting and, because the session
 * is marked bridged, the chain treats the call as successfully connected and
 * never advances. On a machine verdict for the step that is CURRENTLY active:
 *
 *   ringing  -> the bridge event lost the race (or was lost): hang the B leg
 *               up; the existing no-answer hangup path advances the chain.
 *   bridged  -> flip the session back to ringing (conditionally) and hang the
 *               B leg up, so the same hangup path advances the chain. Guarded
 *               by bridged_at freshness; a missing or old stamp fails safe to
 *               leaving the call alone. The "teammate connected" SMS already
 *               sent at bridge time cannot be recalled; the failed/next-step
 *               notifications that follow tell the true story.
 */
async function handleHandoffAmd(
  supabase: SupabaseClient,
  eventType: string,
  payload: Record<string, unknown>,
  handoff: { aLegCallId: string; step: number },
  bLegCallControlId: string
): Promise<Response> {
  // A greeting event carrying a BEEP is machine evidence in its own right,
  // same as the outbound path: a beep-first voicemail would otherwise never
  // stamp the step and the chain would stay stuck, the exact hole this
  // handler exists to close.
  const isDetection = AMD_DETECTION_EVENTS.has(eventType);
  const beepMachine = !isDetection && greetingImpliesMachine(payload["result"]);
  if (!isDetection && !beepMachine) return jsonOk("amd_handoff_ignored");
  const verdict = isDetection ? classifyAmdResult(payload["result"]) : "machine";
  const { data } = await supabase
    .from("voice_handoff_sessions")
    .select("status, current_step, context, business_id")
    .eq("call_control_id", handoff.aLegCallId)
    .maybeSingle();
  const sess = data as
    | {
        status?: string;
        current_step?: number;
        context?: Record<string, unknown>;
        business_id?: string;
      }
    | null;
  await telemetryRecord(supabase, "voice_amd_verdict", {
    call_control_id: bLegCallControlId,
    business_id: sess?.business_id ?? null,
    event_type: eventType,
    result: typeof payload["result"] === "string" ? payload["result"] : null,
    verdict,
    leg: "handoff"
  });
  if (verdict !== "machine") return jsonOk(`amd_handoff_${verdict}`);
  if (!sess || sess.current_step !== handoff.step) return jsonOk("amd_handoff_stale");
  const apiKey = Deno.env.get("TELNYX_API_KEY") ?? "";

  /**
   * Mark this step machine-answered, THEN hang the leg up. The hangup this
   * triggers arrives as normal_clearing (an API hangup on an answered leg),
   * which the hangup path reads as a completed human call; the marker is
   * what diverts it to advance the chain instead (see the normal_clearing
   * branch). Advancement stays with the hangup path as the single writer,
   * and stamping strictly before the hangup command means the resulting
   * webhook can never observe the marker missing. A failed stamp aborts:
   * hanging up without it would manufacture the exact false-success this
   * exists to prevent.
   */
  const markThenHangUp = async (label: string): Promise<Response> => {
    const { error: markErr } = await supabase.rpc("voice_session_context_merge", {
      p_call_control_id: handoff.aLegCallId,
      p_patch: { amd_machine_steps: { [String(handoff.step)]: true } }
    });
    if (markErr) {
      console.error("amd: handoff machine marker failed; leaving the leg alone", markErr);
      return jsonOk("amd_handoff_mark_failed");
    }
    await telnyxHangupCall(apiKey, bLegCallControlId);
    await telemetryRecord(supabase, "voice_handoff_vm_unstuck", {
      business_id: sess.business_id ?? null,
      a_leg: handoff.aLegCallId,
      b_leg: bLegCallControlId,
      step: handoff.step,
      path: label
    });
    return jsonOk(label);
  };

  if (sess.status === "ringing") {
    return await markThenHangUp("amd_handoff_machine_ringing");
  }
  if (sess.status !== "bridged") return jsonOk("amd_handoff_not_active");
  const bridgedAtRaw = sess.context?.bridged_at;
  const bridgedAt = typeof bridgedAtRaw === "string" ? Date.parse(bridgedAtRaw) : NaN;
  if (!Number.isFinite(bridgedAt) || Date.now() - bridgedAt > HANDOFF_AMD_YANK_WINDOW_MS) {
    return jsonOk("amd_handoff_machine_stale_bridge");
  }
  // Flip FIRST, conditionally, so the session is back in the ringing state
  // the hangup path advances from. Losing the flip race (another writer
  // moved the session on) means leaving the call alone, the safe direction.
  const { data: flipped } = await supabase
    .from("voice_handoff_sessions")
    .update({ status: "ringing" })
    .eq("call_control_id", handoff.aLegCallId)
    .eq("status", "bridged")
    .eq("current_step", handoff.step)
    .select("call_control_id");
  if (!(flipped ?? []).length) return jsonOk("amd_handoff_flip_lost");
  return await markThenHangUp("amd_handoff_machine_unstuck");
}

/**
 * Our voicemail message finished playing. End the leg now rather than let it
 * run to the recording's own limit, which would bill voice minutes for silence.
 */
async function handleSpeakEnded(
  supabase: SupabaseClient,
  payload: Record<string, unknown>
): Promise<Response> {
  const callControlId = String(payload["call_control_id"] ?? "");
  const outbound = parseOutboundClientState(payload["client_state"] as string | undefined);
  if (!outbound || !callControlId) return jsonOk("speak_not_outbound");
  // Only OUR voicemail speak ends the call. The same event fires for any other
  // speak on the leg, and hanging up on those would cut a live call short.
  const { data } = await supabase
    .from("voice_handoff_sessions")
    .select("context")
    .eq("call_control_id", callControlId)
    .maybeSingle();
  const ctx = ((data as { context?: Record<string, unknown> } | null)?.context ??
    {}) as Record<string, unknown>;
  if (ctx.voicemail_spoken !== true) return jsonOk("speak_not_voicemail");
  await telnyxHangupCall(Deno.env.get("TELNYX_API_KEY") ?? "", callControlId);
  return jsonOk("voicemail_left_hangup");
}

/**
 * Record what happened to a "reach a teammate" B leg.
 *
 * The assistant dials a teammate on a SEPARATE leg while the caller keeps
 * talking to it, so the caller never hears ringback and the assistant is still
 * there to explain if nobody picks up. The bridge that placed that leg runs on
 * a VPS and receives no webhooks, and Telnyx's call-status endpoint reports
 * only `is_alive`, which is equally true of a phone that is merely ringing. So
 * the one place that learns "they actually answered" is this webhook, and it
 * writes that onto the CALLER's session where the bridge is already polling.
 *
 * Returns null for any leg that is not a reach attempt, so every other handler
 * downstream is untouched.
 */
async function handleReachLeg(
  supabase: SupabaseClient,
  eventType: string,
  payload: Record<string, unknown>
): Promise<Response | null> {
  const state = parseReachClientState(payload["client_state"] as string | undefined);
  if (!state) return null;
  const bLeg = String(payload["call_control_id"] ?? "");
  const status = eventType === "call.answered" ? "answered" : "no_answer";

  // One statement, not read-modify-write. `call.answered` and `call.hangup`
  // are separate deliveries and can be in flight together, so reading the
  // prior state here and writing it back would let both decide they may write
  // and let the later one win. If the loser is the `answered`, the bridge
  // never learns the teammate picked up: it apologizes to a caller who
  // actually got through and leaves the teammate holding a dead line.
  //
  // The precedence lives in record_reach_outcome, mirroring
  // reachOutcomeShouldApply, which is the readable rule with the unit tests.
  const { data: wrote, error } = await supabase.rpc("record_reach_outcome", {
    p_a_leg: state.aLegCallControlId,
    p_attempt: state.attempt,
    p_status: status,
    p_b_leg: bLeg
  });
  if (error) {
    // The bridge falls back to its own ring timeout, so a lost stamp costs a
    // slower move to the next teammate rather than a stuck call.
    console.error("reach: outcome stamp failed", error);
    return jsonOk("reach_stamp_failed");
  }
  // A superseded event (an older attempt reporting late, or a hangup after the
  // same attempt answered) is a normal, expected delivery, not a failure.
  if (wrote !== true) return jsonOk("reach_superseded");
  await telemetryRecord(supabase, "voice_reach_leg", {
    business_id: state.businessId,
    a_leg: state.aLegCallControlId,
    b_leg: bLeg,
    attempt: state.attempt,
    status
  });
  return jsonOk(`reach_${status}`);
}

/**
 * Un-stamp a PROVISIONAL machine verdict once screening proves a person.
 *
 * Two stamps were written at detection.ended and both must be reversed:
 * `machine_detected` on the session context (drives the flow outcome, so a
 * screened call a human answers settles as answered, not no_answer) and
 * `answering_machine_result` on the transcript row (drives the call page's
 * AnsweringMachineBadge, which would otherwise label a real conversation a
 * machine). The transcript write is a compare-and-swap on "machine" so a
 * later legitimate value can never be blanked; zero rows matching is fine.
 * Best-effort throughout, a failed clear understates, never misroutes.
 */
async function clearProvisionalMachine(
  supabase: SupabaseClient,
  callControlId: string,
  extraContext: Record<string, unknown>
): Promise<void> {
  const { error: ctxErr } = await supabase.rpc("voice_session_context_merge", {
    p_call_control_id: callControlId,
    p_patch: { ...extraContext, machine_detected: false }
  });
  if (ctxErr) console.error("amd: provisional machine clear failed", ctxErr);
  const { error: badgeErr } = await supabase
    .from("voice_call_transcripts")
    .update({ answering_machine_result: null })
    .eq("call_control_id", callControlId)
    .eq("answering_machine_result", "machine");
  if (badgeErr) console.error("amd: transcript badge clear failed", badgeErr);
}

/**
 * Did Apple call screening actually announce itself on this leg?
 *
 * Only `call.machine.premium.call_screening.detected` sets this. It is the one
 * signal that separates "a person is screening the call" from "a voicemail
 * greeting just ended", which `prompt_ended` alone does NOT distinguish.
 */
async function iosScreeningDetected(
  supabase: SupabaseClient,
  callControlId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("voice_handoff_sessions")
    .select("context")
    .eq("call_control_id", callControlId)
    .maybeSingle();
  const ctx = ((data as { context?: Record<string, unknown> } | null)?.context ??
    {}) as Record<string, unknown>;
  return ctx.ios_screening === true;
}

/** Has a machine verdict already been recorded for this leg? */
async function machineAlreadyStamped(
  supabase: SupabaseClient,
  callControlId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("voice_handoff_sessions")
    .select("context")
    .eq("call_control_id", callControlId)
    .maybeSingle();
  const ctx = ((data as { context?: Record<string, unknown> } | null)?.context ??
    {}) as Record<string, unknown>;
  return ctx.machine_detected === true;
}

/**
 * The voicemail message configured for this leg, or "" when the step set none.
 *
 * No script is the historical behavior and the safe default: hang up on the
 * verdict rather than hold a leg open speaking at a recording nobody asked for.
 */
async function voicemailScriptFor(
  supabase: SupabaseClient,
  callControlId: string
): Promise<string> {
  const { data } = await supabase
    .from("voice_handoff_sessions")
    .select("context")
    .eq("call_control_id", callControlId)
    .maybeSingle();
  const ctx = ((data as { context?: Record<string, unknown> } | null)?.context ??
    {}) as Record<string, unknown>;
  const vm = ctx.voicemail as { script?: unknown } | undefined;
  return typeof vm?.script === "string" ? vm.script.trim() : "";
}

/**
 * Speak the configured voicemail message, once, and mark that we did.
 *
 * Called on `greeting.ended`, which premium AMD fires when the outgoing
 * greeting has finished: the only moment a message records in full rather than
 * over the top of "please leave a message after the tone".
 *
 * Does NOT hang up. `call.speak.ended` does that, so the leg ends when the
 * message actually finishes rather than mid-sentence. If that event never
 * arrives the voicemail system's own recording limit ends the call, which is
 * the same bound a human leaving a message would hit.
 */
async function speakVoicemail(
  supabase: SupabaseClient,
  callControlId: string,
  script: string
): Promise<Response> {
  const apiKey = Deno.env.get("TELNYX_API_KEY") ?? "";
  /**
   * End the leg the way the pre-voicemail path did. Used whenever a message
   * cannot be left: the Gemini bridge is still attached from call.answered, so
   * leaving the leg up means the assistant keeps talking into the recording and
   * the run stays parked until something else ends the call.
   */
  const giveUpAndHangUp = async (label: string): Promise<Response> => {
    await telnyxStreamingStop(apiKey, callControlId);
    await telnyxHangupCall(apiKey, callControlId);
    return jsonOk(label);
  };

  // Claim the right to speak in ONE statement. Check-then-speak loses to
  // Telnyx's at-least-once redelivery: two deliveries both read "not spoken"
  // and the assistant talks over itself into a single recording.
  const { data: claimed, error: claimErr } = await supabase.rpc("voice_claim_voicemail_speak", {
    p_call_control_id: callControlId
  });
  if (claimErr) {
    console.error("amd: voicemail claim failed", claimErr);
    return await giveUpAndHangUp("amd_voicemail_claim_failed");
  }
  // Someone else holds the claim. They own the leg's ending, so leave it alone
  // rather than hanging up a call that is mid-message.
  if (claimed !== true) return jsonOk("amd_voicemail_already_claimed");

  // Silence the Gemini bridge BEFORE speaking. It was attached on
  // call.answered, before anyone knew a machine had picked up, and hanging up
  // is what used to silence it. A leg held open to leave a message has to stop
  // the fork explicitly or the recording gets the assistant talking through
  // the greeting and over the message.
  const stopped = await telnyxStreamingStop(apiKey, callControlId);
  if (!stopped.ok) {
    // Speaking now would record our message UNDER the assistant's chatter.
    // A clean "no message" beats an unintelligible one.
    console.error(
      "amd: streaming_stop before voicemail failed",
      callControlId,
      stopped.status,
      (await stopped.text()).slice(0, 300)
    );
    const { error: relErr } = await supabase.rpc("voice_release_voicemail_claim", {
      p_call_control_id: callControlId
    });
    if (relErr) console.error("amd: voicemail claim release failed", relErr);
    return await giveUpAndHangUp("amd_voicemail_stream_stop_failed");
  }

  const res = await telnyxSpeak(apiKey, callControlId, script);
  if (!res.ok) {
    console.error("amd: voicemail speak failed", callControlId, res.status, await res.text());
    const { error: relErr } = await supabase.rpc("voice_release_voicemail_claim", {
      p_call_control_id: callControlId
    });
    if (relErr) console.error("amd: voicemail claim release failed", relErr);
    return await giveUpAndHangUp("amd_voicemail_speak_failed");
  }

  // Only NOW is a message actually going out. voicemail_spoken is what the
  // hangup path derives the outcome reason from and what call.speak.ended
  // checks before releasing the leg, so it is deliberately written after the
  // speak succeeds rather than as part of the claim: a leg that died between
  // claiming and speaking must not report a message nobody heard.
  const { error: markErr } = await supabase.rpc("voice_session_context_merge", {
    p_call_control_id: callControlId,
    p_patch: { voicemail_spoken: true }
  });
  if (markErr) {
    // The message IS being spoken; losing the stamp only understates it.
    console.error("amd: voicemail_spoken stamp failed", markErr);
  }
  return jsonOk("amd_voicemail_spoken");
}

/**
 * Make the voicemail visible on the call record itself, at hangup time.
 *
 * Two writes, both of which were missing and left the dashboard blind to
 * voicemails the system was genuinely leaving (Jessica Gutierrez, Aug 12 2026:
 * two calls, two voicemails left, transcript page showed neither):
 *
 * 1. `answering_machine_result` + `voicemail_left` on the transcript row, which
 *    the call page's AnsweringMachineBadge reads. The mid-call write in
 *    stampMachine stays as belt-and-braces, but the row is only guaranteed to
 *    exist by hangup, so this is the authoritative one.
 * 2. A closing "[Voicemail] …" assistant turn carrying the spoken script. The
 *    message goes out through Telnyx `speak` AFTER the media stream is stopped,
 *    so the bridge's transcriber never hears it and nothing else can put it in
 *    the transcript. Claim-guarded (voice_claim_voicemail_turn) because
 *    call.hangup is delivered at-least-once and each redelivery runs this path.
 *
 * Best-effort throughout: the parked run's outcome is derived from the session
 * context, never from these rows, so a failed decoration understates the record
 * without changing behavior.
 */
async function decorateTranscriptForVoicemail(
  supabase: SupabaseClient,
  callControlId: string,
  opts: { voicemailLeft: boolean; script: string; endedAtIso: string }
): Promise<void> {
  const { data: rows, error } = await supabase
    .from("voice_call_transcripts")
    .update({
      answering_machine_result: "machine",
      voicemail_left: opts.voicemailLeft,
      // Overwrites the bridge's finalize stamp, which dates from the
      // streaming stop BEFORE the message was spoken; without this the
      // dashboard duration excludes the voicemail itself (Bugbot, #1335).
      ended_at: opts.endedAtIso,
      updated_at: opts.endedAtIso
    })
    .eq("call_control_id", callControlId)
    .select("id");
  if (error) {
    console.error("amd: transcript voicemail decorate failed", callControlId, error);
    return;
  }
  const transcriptId = ((rows ?? [])[0] as { id?: string } | undefined)?.id;
  if (!transcriptId) {
    // Zero rows matched. PostgREST reports success for that, which is exactly
    // how the mid-call variant of this write went unnoticed, so say it out
    // loud. Reachable when the bridge never created a row (pre-eager-create
    // boxes, or a leg that died before attach).
    console.error("amd: transcript voicemail decorate matched no row", callControlId);
    return;
  }
  if (!opts.voicemailLeft || !opts.script) return;

  const { data: claimed, error: claimErr } = await supabase.rpc("voice_claim_voicemail_turn", {
    p_call_control_id: callControlId
  });
  if (claimErr) {
    console.error("amd: voicemail turn claim failed", callControlId, claimErr);
    return;
  }
  if (claimed !== true) return;

  // Append after whatever the bridge transcribed (usually the machine's own
  // greeting, recorded as a caller turn). The stream is stopped before the
  // speak, so no bridge flush can still be racing for an index by now.
  const { data: lastTurn } = await supabase
    .from("voice_call_transcript_turns")
    .select("turn_index")
    .eq("transcript_id", transcriptId)
    .order("turn_index", { ascending: false })
    .limit(1);
  const nextIndex =
    (((lastTurn ?? [])[0] as { turn_index?: number } | undefined)?.turn_index ?? -1) + 1;
  const { error: turnErr } = await supabase.from("voice_call_transcript_turns").insert({
    transcript_id: transcriptId,
    role: "assistant",
    content: `[Voicemail] ${opts.script}`,
    turn_index: nextIndex
  });
  if (turnErr) {
    console.error("amd: voicemail turn insert failed", callControlId, turnErr);
  }
}

/**
 * Record the machine verdict on the session, WITHOUT ending the leg.
 *
 * Split out from stampMachineAndHangUp because a step with a voicemail script
 * needs the leg to stay up long enough to speak into it. Returns false when the
 * stamp did not land, which is the caller's signal to leave the call alone: a
 * missing stamp makes the hangup derive "answered", and a follow-up ladder
 * would stop on a lead who heard nothing.
 */
async function stampMachine(
  supabase: SupabaseClient,
  callControlId: string
): Promise<boolean> {
  // A merge, not a read-modify-write: this handler and the greeting handler can
  // be delivered concurrently, and a stamp built from a context read before the
  // voicemail was spoken would clobber voicemail_spoken. call.speak.ended would
  // then decline to hang up and the run would report that no message was left.
  const { error: stampErr } = await supabase.rpc("voice_session_context_merge", {
    p_call_control_id: callControlId,
    p_patch: { machine_detected: true }
  });
  if (stampErr) {
    console.error("amd: machine stamp failed, leaving the call up", stampErr);
    return false;
  }
  // Surface the verdict on the call itself, not just in flow vars. Without
  // this an owner reviewing the call cannot tell a voicemail from a person
  // answering, which is exactly the confusion AMD exists to remove.
  // Best-effort: with lazy row creation this matched zero rows on EVERY call
  // (PostgREST reports success for that), which is why the badge never showed.
  // The bridge now creates the row at attach, and the hangup path re-writes
  // the verdict either way, so this early write is belt-and-braces for owners
  // watching a call live.
  const { data: marked, error: markErr } = await supabase
    .from("voice_call_transcripts")
    .update({ answering_machine_result: "machine" })
    .eq("call_control_id", callControlId)
    .select("id");
  if (markErr) console.error("amd: transcript mark failed", markErr);
  else if (!(marked ?? []).length) {
    console.warn("amd: transcript mark matched no row (pre-eager-create bridge?)", callControlId);
  }
  return true;
}

/**
 * Record the machine verdict on the session and end the leg. The hangup this
 * triggers flows through the outbound path, which reads the stamp and resumes
 * the parked run; this function deliberately does not resume it itself, so
 * there is exactly one writer.
 *
 * A stamp failure leaves the call up rather than hanging up AND mis-reporting
 * it: the AI talking to a voicemail wastes minutes, which is the cheaper of
 * the two failures.
 */
async function stampMachineAndHangUp(
  supabase: SupabaseClient,
  callControlId: string
): Promise<Response> {
  if (!(await stampMachine(supabase, callControlId))) return jsonOk("amd_stamp_failed");
  await telnyxHangupCall(Deno.env.get("TELNYX_API_KEY") ?? "", callControlId);
  return jsonOk("amd_machine_hangup");
}

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
    // a LATER step is ringing, that would freeze the chain (subsequent
    // no-answer hangups would be ignored as "not ringing"). `.select()` tells us
    // whether THIS event was the one that flipped ringing→bridged, so the
    // success SMS fires exactly once (concurrent/duplicate bridged events get an
    // empty result and skip).
    const { data: bridgedRows } = await supabase
      .from("voice_handoff_sessions")
      .update({ status: "bridged" })
      .eq("call_control_id", parsed.aLegCallId)
      .eq("status", "ringing")
      .eq("current_step", parsed.step)
      .select("business_id, from_e164, context");
    const bridged = (bridgedRows ?? [])[0] as
      | { business_id: string; from_e164: string; context: HandoffContext }
      | undefined;
    if (bridged) {
      // Freshness stamp for the AMD un-stick: a machine verdict fires seconds
      // after a voicemail answers, so handleMachineDetection may yank a
      // bridged leg ONLY while the bridge is this young. Best-effort; a
      // missing stamp fails safe (no yank). Written after the flip rather
      // than in it (context is jsonb; merging in the same statement would be
      // a read-modify-write race with every other context writer).
      const { error: stampErr } = await supabase.rpc("voice_session_context_merge", {
        p_call_control_id: parsed.aLegCallId,
        p_patch: { bridged_at: new Date().toISOString() }
      });
      if (stampErr) console.error("handoff: bridged_at stamp failed", stampErr);
      const recipientE164 = bridged.context?.steps?.[parsed.step]?.to_e164 ?? "";
      if (recipientE164) {
        await sendWarmTransferNotifications(supabase, deps.apiKey, {
          businessId: bridged.business_id,
          callerE164: bridged.from_e164 ?? "",
          recipientE164,
          outcome: "success",
          dedupeKey: `hl:success:${parsed.aLegCallId}`,
          starFrame: bridged.context?.star_alerts === true
        });
      }
    }
    return { handled: true, response: jsonOk("handoff_bridged") };
  }

  // call.hangup, outbound AiFlow leg. Unlike inbound (which always answers and
  // engages the AI within ms), an outbound call commonly rings out unanswered.
  // call.answered then never runs, so its pre-answer reservation would sit in
  // `pending_answer` holding a concurrency slot until the stale-settlement sweep.
  // Release it now when the leg ended without ever attaching the stream
  // (answer_issued_at is null). If it WAS answered, fall through to normal
  // settlement so the media minutes are billed.
  const outbound = parseOutboundClientState(payload["client_state"] as string | undefined);
  if (outbound && callControlId) {
    // Read the session BEFORE flipping it terminal: the context carries the
    // place_ai_call run link (flow_run) plus the bridge's transfer_initiated
    // stamp, which together decide the outcome the parked run resumes with.
    const { data: obSessRow } = await supabase
      .from("voice_handoff_sessions")
      .select("context")
      .eq("call_control_id", callControlId)
      .maybeSingle();
    const obCtx = ((obSessRow as { context?: Record<string, unknown> } | null)?.context ??
      {}) as {
      transfer_initiated?: unknown;
      flow_run?: FlowRunLink;
      machine_detected?: unknown;
      voicemail_spoken?: unknown;
      voicemail?: { script?: unknown };
    };
    await supabase
      .from("voice_handoff_sessions")
      .update({ status: "done" })
      .eq("call_control_id", callControlId);
    const { data: resvRow } = await supabase
      .from("voice_reservations")
      .select("answer_issued_at")
      .eq("call_control_id", callControlId)
      .maybeSingle();
    const answered = Boolean(
      (resvRow as { answer_issued_at?: string | null } | null)?.answer_issued_at
    );
    // Resume the parked batch run (place_ai_call) with the call's outcome.
    // Status-guarded: if the bridge already resumed it with "transferred" at
    // transfer time, this write is a no-op. Best-effort, a miss is
    // backstopped by the resume_overdue_call_waits sweep.
    if (obCtx.flow_run) {
      // A machine picking up ANSWERS the leg, so answer_issued_at is set and
      // the plain derivation below would report "answered" for a call the lead
      // never heard. The AMD stamp is what tells the two apart. It rides a
      // no_answer outcome on purpose: for retry purposes reaching a voicemail
      // is the same as nobody picking up, so a ladder written before AMD
      // existed keeps working unchanged, and the REASON carries the detail.
      const machine = obCtx.machine_detected === true;
      // Surface the voicemail on the transcript itself. This is the one point
      // where the row reliably exists (the bridge finalized it when the stream
      // stopped, seconds before the speak ended and the leg hung up), unlike
      // the mid-call stamp in stampMachine, which raced row creation for its
      // whole life and silently matched zero rows.
      if (machine) {
        // The bridge finalized ended_at when the media stream stopped, which
        // on a voicemail call is BEFORE the message plays: the recorded span
        // covered only the machine's greeting. The hangup is the true end, so
        // re-stamp it from the webhook's own end_time (wall clock as backstop).
        const endMs = Date.parse(String(payload["end_time"] ?? ""));
        await decorateTranscriptForVoicemail(supabase, callControlId, {
          voicemailLeft: obCtx.voicemail_spoken === true,
          script:
            typeof obCtx.voicemail?.script === "string" ? obCtx.voicemail.script.trim() : "",
          endedAtIso: new Date(Number.isFinite(endMs) ? endMs : Date.now()).toISOString()
        });
      }
      const outcome = obCtx.transfer_initiated === true
        ? "transferred"
        : machine
          ? "no_answer"
          : answered
            ? "answered"
            : "no_answer";
      await resumeFlowRunWithCallOutcome(
        supabase,
        obCtx.flow_run,
        outcome,
        machine
          ? // Both ride no_answer; the reason is what tells the team (and the
            // flow's own copy) whether the lead has actually heard from us.
            obCtx.voicemail_spoken === true
            ? CALL_REASON.VOICEMAIL_LEFT
            : CALL_REASON.VOICEMAIL_NO_MESSAGE
          : undefined
      );
    }
    if (!answered) {
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
    // hangup means the human answered and the call completed, don't advance.
    //
    // UNLESS the AMD handler marked this step's leg as machine-answered. It
    // hangs the leg up itself, and an API hangup on an answered leg arrives
    // as normal_clearing too, so without the marker a voicemail pickup would
    // read as a completed human call: the session would flip to bridged, a
    // false success SMS would go out, and the chain would stay stuck. The
    // marker is stamped BEFORE the hangup command is issued, so this event
    // cannot observe it missing.
    const cause = String(payload["hangup_cause"] ?? "").toLowerCase();
    const machineMarked = sess.context?.amd_machine_steps?.[String(parsed.step)] === true;
    if (cause === "normal_clearing" && !machineMarked) {
      // `.select()` tells us whether THIS event flipped ringing→bridged. If it
      // did (call.bridged was dropped but the human answered), send the success
      // SMS that the bridged branch would have. The shared hl:success key makes
      // it a no-op if call.bridged already notified. `bridged` (not `done`) so
      // the A-leg terminal below records this call as ANSWERED, any non-ringing
      // status equally stops chain advancement, so semantics don't change.
      const { data: doneRows } = await supabase
        .from("voice_handoff_sessions")
        .update({ status: "bridged" })
        .eq("call_control_id", parsed.aLegCallId)
        .eq("status", "ringing")
        .select("business_id, from_e164, context");
      const done = (doneRows ?? [])[0] as
        | { business_id: string; from_e164: string; context: HandoffContext }
        | undefined;
      if (done) {
        const recipientE164 = done.context?.steps?.[parsed.step]?.to_e164 ?? "";
        if (recipientE164) {
          await sendWarmTransferNotifications(supabase, deps.apiKey, {
            businessId: done.business_id,
            callerE164: done.from_e164 ?? "",
            recipientE164,
            outcome: "success",
            dedupeKey: `hl:success:${parsed.aLegCallId}`,
            starFrame: done.context?.star_alerts === true
          });
        }
      }
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
    .select("call_control_id, status, business_id, from_e164")
    .eq("call_control_id", callControlId)
    .maybeSingle();
  if (!sessRow) return { handled: false, response: jsonOk("ignored_hangup") };
  const sessEnd = sessRow as {
    status?: string;
    business_id?: string;
    from_e164?: string;
  };
  const priorStatus = String(sessEnd.status ?? "");
  // A run parked on this call by a `wait_for_call` step is deliberately NOT
  // resumed here. The bridge owns that resume because it writes the captured
  // lead fields first, and this webhook races its teardown: resuming from here
  // could wake the worker against a session whose capture blob has not landed,
  // losing the seller's phone number, which is the whole point of the step. A
  // bridge that dies before it gets there is covered by resume_overdue_call_waits
  // (the same no-webhook backstop place_ai_call relies on for its transfers).
  await supabase
    .from("voice_handoff_sessions")
    .update({ status: "done" })
    .eq("call_control_id", callControlId);
  // The A-leg hangup is the handoff chain's terminal event, record the
  // call-log row for the human-only outcomes. `bridged` means a human step
  // answered (answered forwarded call); `ringing`/`done` mean nobody did and
  // no AI takeover happened (missed → auto-text + blocked ledger + spike).
  // `ai_intake` is skipped: the AI bridge writes its own transcript row for
  // this same call_control_id, and a forwarded upsert would clobber it.
  if (priorStatus !== "ai_intake" && sessEnd.business_id) {
    await logForwardedCallOutcome(deps, {
      businessId: sessEnd.business_id,
      callControlId,
      callerE164: sessEnd.from_e164 || null,
      forwardedToE164: null,
      startedAtIso: String(payload["start_time"] ?? "") || null,
      outcome: priorStatus === "bridged" ? "answered" : "missed",
      context: "handoff_chain"
    });
    // Meter the A-leg's carrier time when a human answered the chain. The
    // platform pays Telnyx for this answered leg's full duration and no
    // reservation ever existed for it (only the ai_intake takeover reserves,
    // and that settles through the normal path). Post-hoc, idempotent,
    // never refuses.
    if (priorStatus === "bridged") {
      await meterForwardedCallSeconds(supabase, {
        businessId: sessEnd.business_id,
        callControlId,
        reportedSeconds: parseCallDurationSeconds(payload),
        context: "handoff_chain"
      });
    }
  }
  // An AI takeover reserved voice budget for this A-leg, so its hangup MUST flow
  // into settlement (signal 1 of 2) to bill the Gemini minutes. Human-only
  // handoffs never reserved, so settlement is a no-op for them, short-circuit
  // to avoid an extra "unknown_call" round-trip.
  if (priorStatus === "ai_intake") {
    return { handled: false, response: jsonOk("handoff_session_closed") };
  }
  return { handled: true, response: jsonOk("handoff_session_closed") };
}

async function wtLookupName(
  supabase: SupabaseClient<any, any, any>,
  table: string,
  match: Record<string, string>,
  column: string
): Promise<string> {
  try {
    let q = supabase.from(table).select(column);
    for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
    const { data } = await q.maybeSingle();
    return String((data as Record<string, unknown> | null)?.[column] ?? "").trim();
  } catch (err) {
    console.error("warm-transfer notify: name lookup failed", table, err);
    return "";
  }
}

/**
 * Send one warm-transfer SMS through the METERED outbound path: reserve a slot
 * against the tenant's monthly cap, send via Telnyx, and release the reservation
 * if Telnyx rejects. Every SMS sent from the AI worker's number is metered, so
 * these operational alerts count against the same monthly pool as customer
 * texts. Returns a coarse outcome so the caller can decide whether to roll back
 * its dedup claim (transient send failure) or keep it (cap reached). Never
 * throws.
 */
async function meteredWarmTransferSend(
  supabase: SupabaseClient<any, any, any>,
  apiKey: string,
  businessId: string,
  msg: { messagingProfileId: string; fromE164?: string; toE164: string; text: string }
): Promise<{ ok: true } | { ok: false; reason: "quota" | "send_failed" | "reserve_error" }> {
  const sendUnits =
    smsTextUnits(msg.text) * smsDestinationMultiplier(smsDestinationCountry(msg.toE164));
  const { data: reserveRaw, error: reserveErr } = await supabase.rpc(
    "try_reserve_sms_outbound_slot",
    { p_business_id: businessId, p_text_units: sendUnits, p_destination_e164: msg.toE164 }
  );
  if (reserveErr) {
    console.error("warm-transfer notify: reserve slot failed", reserveErr);
    return { ok: false, reason: "reserve_error" };
  }
  const reserve = reserveRaw as { ok?: boolean; reason?: string; source?: string } | null;
  if (!reserve?.ok) {
    // Over the monthly cap: alert the owner once per period (same channel the
    // other metered send paths use), then skip, retrying won't help this month.
    if (reserve?.reason === "monthly_sms_limit") {
      await sendCapAlertOnce(supabase, {
        businessId,
        kind: "sms_monthly",
        periodKey: smsCapPeriodKey(),
        notifyUrl: `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/notifications`,
        bearer: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
        payload: { surface: "warm_transfer" }
      });
    }
    return { ok: false, reason: "quota" };
  }

  const res = await telnyxSendSms({
    apiKey,
    messagingProfileId: msg.messagingProfileId,
    fromE164: msg.fromE164,
    toE164: msg.toE164,
    text: msg.text
  }).catch((err) => {
    console.error("warm-transfer notify: SMS threw", err);
    return { ok: false, status: 0, body: "threw" };
  });
  if (!res.ok) {
    console.error("warm-transfer notify: SMS failed", res.status, res.body);
    // Telnyx rejected the send: give the reserved units back so the tenant
    // isn't billed for a message that never went out.
    const { error: relErr } = await supabase.rpc("release_sms_outbound_slot", {
      p_business_id: businessId,
      p_refund_bonus: reserve.source === "bonus",
      p_text_units: sendUnits
    });
    if (relErr) console.error("warm-transfer notify: release slot failed", relErr);
    return { ok: false, reason: "send_failed" };
  }
  return { ok: true };
}

/**
 * Resolve display names + tenant SMS settings and, gated on a dedup claim so
 * retried/duplicate webhooks don't double-text, send the recipient (and
 * conditionally owner) warm-transfer SMS. Best-effort: never throws.
 */
async function sendWarmTransferNotifications(
  supabase: SupabaseClient<any, any, any>,
  apiKey: string,
  args: {
    businessId: string;
    callerE164: string;
    recipientE164: string;
    outcome: WtOutcome;
    dedupeKey: string;
    /**
     * Frame both texts in a row of asterisks (the handoff chain's flow set
     * `options.starAlerts`). Omitted everywhere else, so the receptionist and
     * caller-rule `wt:` notices stay exactly as they were.
     */
    starFrame?: boolean;
  }
): Promise<{ sent: boolean; reason?: string }> {
  const { businessId, callerE164, recipientE164, outcome, dedupeKey } = args;
  // The BODY is never rewritten, only framed, so a starred notice reads
  // identically to its plain twin.
  const frame = (text: string): string => (args.starFrame ? starBlock(text) : text);
  if (!apiKey) return { sent: false, reason: "no_api_key" };
  if (!recipientE164) return { sent: false, reason: "no_recipient" };

  // Respect the tenant's "Warm transfer SMS" notification preference. Fail open:
  // a missing row means the feature's default (ON) applies; only an explicit
  // false suppresses. Do this before claiming the dedup key so a re-enable can
  // still fire on a later delivery of the same event.
  try {
    const { data: pref } = await supabase
      .from("notification_preferences")
      .select("sms_warm_transfer")
      .eq("business_id", businessId)
      .maybeSingle();
    if ((pref as { sms_warm_transfer?: boolean } | null)?.sms_warm_transfer === false) {
      return { sent: false, reason: "pref_disabled" };
    }
  } catch (err) {
    console.error("warm-transfer notify: prefs load failed (defaulting on)", err);
  }

  // Tenant SMS settings + owner number. Bail before claiming the dedup key when
  // we can't send, so a misconfigured tenant can be retried later.
  let settings: {
    forward_to_e164?: string | null;
    telnyx_sms_from_e164?: string | null;
    telnyx_messaging_profile_id?: string | null;
  } | null = null;
  try {
    const { data } = await supabase
      .from("business_telnyx_settings")
      .select("forward_to_e164, telnyx_sms_from_e164, telnyx_messaging_profile_id")
      .eq("business_id", businessId)
      .maybeSingle();
    settings = data ?? null;
  } catch (err) {
    console.error("warm-transfer notify: settings load failed", err);
    return { sent: false, reason: "settings_error" };
  }
  const ownerE164 = normE164(settings?.forward_to_e164);
  const fromE164 = normE164(settings?.telnyx_sms_from_e164);
  const messagingProfileId = normE164(settings?.telnyx_messaging_profile_id);
  // telnyxSendSms requires a messaging profile (the `from` may be picked from
  // the profile's number pool). No profile ⇒ we can't send.
  if (!messagingProfileId) return { sent: false, reason: "no_sms_sender" };

  // Dedup claim, only the first writer proceeds to send.
  const { error: claimErr } = await supabase
    .from("voice_transfer_notifications")
    .insert({ dedupe_key: dedupeKey, business_id: businessId, outcome });
  if (claimErr) {
    const code = (claimErr as { code?: string }).code;
    return { sent: false, reason: code === "23505" ? "duplicate" : "claim_error" };
  }

  // Resolve display names (best-effort; number-only fallback when unknown).
  const callerName = callerE164
    ? await wtLookupName(supabase, "contacts", { business_id: businessId, customer_e164: callerE164 }, "display_name")
    : "";
  const recipName = recipientIsOwner(recipientE164, ownerE164)
    ? await wtLookupName(supabase, "businesses", { id: businessId }, "owner_name")
    : await wtLookupName(
        supabase,
        "ai_flow_team_members",
        { business_id: businessId, phone_e164: recipientE164 },
        "name"
      );
  const callerLabel = labelFor(callerName, callerE164, "the caller");
  const recipientLabel = labelFor(recipName, recipientE164, "your teammate");
  const from = fromE164 || undefined;

  const recip = await meteredWarmTransferSend(supabase, apiKey, businessId, {
    messagingProfileId,
    fromE164: from,
    toE164: recipientE164,
    text: frame(buildRecipientMessage(outcome, callerLabel))
  });
  if (!recip.ok) {
    if (recip.reason === "send_failed" || recip.reason === "reserve_error") {
      // Transient failure on the primary alert. Roll back the dedup claim so a
      // later delivery of the same event (or a manual re-drive) can retry
      // instead of being permanently suppressed by the claim we just wrote.
      await supabase.from("voice_transfer_notifications").delete().eq("dedupe_key", dedupeKey);
      return { sent: false, reason: `recipient_${recip.reason}` };
    }
    // Over the monthly cap: nothing was sent and a retry won't help this period.
    // Keep the claim so duplicate webhooks don't re-attempt; the owner is
    // separately alerted about the cap inside meteredWarmTransferSend.
    return { sent: false, reason: "monthly_sms_limit" };
  }

  if (shouldNotifyOwner(recipientE164, ownerE164)) {
    // Owner copy is secondary: a failure here is logged but does NOT roll back
    // the claim (the recipient was already texted, and a retry would double-text
    // them). At-most-once for the recipient wins over the owner copy.
    const owner = await meteredWarmTransferSend(supabase, apiKey, businessId, {
      messagingProfileId,
      fromE164: from,
      toE164: ownerE164,
      text: frame(buildOwnerMessage(outcome, recipientLabel, callerLabel))
    });
    if (!owner.ok) {
      console.error("warm-transfer notify: owner SMS not sent", owner.reason);
    }
  }

  return { sent: true };
}

/**
 * Forwarded-call bookkeeping, shared by the single-leg `wt:` transfer path and
 * the handoff-chain A-leg terminal. Writes the call-log row (so transferred/
 * forwarded calls show up in the dashboard's call history alongside AI calls),
 * and for a MISSED forwarded call runs the same follow-ups as a refused
 * inbound call: caller auto-text (Standard/Enterprise, forwarded_no_answer),
 * the `voice_call_blocked` ledger row (answer-rate card + spike counter), and
 * the once-per-day missed-call spike alert. Never throws, logging must not
 * break webhook handling (settlement/handoff advancement).
 *
 * Returns the call-log record status (null on an unexpected throw) so callers
 * can detect `superseded`, a missed-cause hangup on a call a human actually
 * answered (call.bridged landed first), and still meter its carrier time.
 */
async function logForwardedCallOutcome(
  deps: HandoffDeps,
  args: {
    businessId: string;
    callControlId: string;
    callerE164: string | null;
    forwardedToE164: string | null;
    startedAtIso: string | null;
    outcome: ForwardedCallOutcome;
    /** Ledger/telemetry tag: which forwarding path produced this outcome. */
    context: string;
  }
): Promise<ForwardedCallLogResult["status"] | null> {
  const { supabase } = deps;
  try {
    const rec = await recordForwardedCall(supabase, {
      businessId: args.businessId,
      callControlId: args.callControlId,
      outcome: args.outcome,
      callerE164: args.callerE164,
      forwardedToE164: args.forwardedToE164,
      startedAtIso: args.startedAtIso
    });
    if (rec.status === "failed") {
      // Deliberately NOT a gate for the follow-ups below: the call really was
      // missed regardless of whether its history row landed, and suppressing
      // the caller's auto-text (their only recovery path) over a transient
      // write failure to a different table would trade a customer-facing
      // feature for log consistency. The error is loud here for ops.
      console.error("forwarded call log failed", args.context, rec.reason);
    }
    if (args.outcome !== "missed") return rec.status;
    // `superseded`: an answered row already exists for this call (missed is
    // insert-only, so a reordered/duplicate hangup can't downgrade it), the
    // human DID answer, so the missed-call follow-ups must not fire.
    if (rec.status === "superseded") return rec.status;

    const missedAt = new Date();
    const autotext = await sendMissedCallAutotext(supabase, {
      businessId: args.businessId,
      callerE164: args.callerE164,
      reason: "forwarded_no_answer",
      telnyxApiKey: deps.apiKey,
      defaultMessagingProfileId: Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") ?? "",
      defaultFromE164: Deno.env.get("TELNYX_SMS_FROM_E164") ?? ""
    });
    await telemetryRecord(supabase, "voice_missed_call_autotext", {
      business_id: args.businessId,
      call_control_id: args.callControlId,
      reason: "forwarded_no_answer",
      outcome: autotext.status,
      detail: autotext.reason ?? null
    });
    // Same ledger row every refusal path writes: it feeds the dashboard
    // answer-rate card AND the spike counter, so a forwarded call that rang
    // out counts as a missed call everywhere the tenant looks.
    await systemLog(supabase, {
      businessId: args.businessId,
      source: "voice",
      level: "warn",
      event: "voice_call_blocked",
      message: "Forwarded call missed: no answer",
      payload: {
        call_control_id: args.callControlId,
        reason: "forwarded_no_answer",
        context: args.context,
        forwarded_to: args.forwardedToE164
      }
    });
    const spike = await maybeSendMissedCallSpikeAlert(supabase, {
      businessId: args.businessId,
      notifyUrl: `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/notifications`,
      bearer: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      now: missedAt
    });
    if (spike.status === "sent") {
      await telemetryRecord(supabase, "voice_missed_call_spike_alert", {
        business_id: args.businessId,
        missed_calls_today: spike.count
      });
    }
    return rec.status;
  } catch (err) {
    console.error("logForwardedCallOutcome threw", args.context, err);
    return null;
  }
}

/**
 * Warm-transfer SMS notifications for the single-leg transfer paths (AI
 * receptionist `transfer_to_owner` + caller-rule blind transfer). Both tag the
 * transfer's B leg with a `wt:` client_state. `call.bridged` on that leg = the
 * recipient answered (success); `call.hangup` with no prior bridge = no-answer
 * (failure). The AiFlow handoff chain has its own success/failure notifications
 * inside `handleHandoffLifecycle`/`advanceHandoff`.
 *
 * Returns `handled:false` for any event that isn't a `wt:` leg so the caller can
 * fall through to the handoff/settlement logic.
 */
async function handleWarmTransferLifecycle(
  deps: HandoffDeps,
  eventType: string,
  payload: Record<string, unknown>
): Promise<{ handled: boolean; response: Response }> {
  const wt = parseWtClientState(payload["client_state"] as string | undefined);
  if (!wt) return { handled: false, response: jsonOk("ignored_wt") };
  const legId = String(payload["call_control_id"] ?? "");
  if (!legId) return { handled: false, response: jsonOk("ignored_wt") };

  // A SINGLE dedup key per leg (not per-outcome) so success and failure are
  // mutually exclusive: whichever event claims the key first sends, and the
  // other is blocked. This prevents a bridged/hangup webhook reorder from
  // texting BOTH "successful" and "missed" for the same transfer.
  const dedupeKey = `wt:${legId}`;

  if (eventType === "call.bridged") {
    await sendWarmTransferNotifications(deps.supabase, deps.apiKey, {
      businessId: wt.businessId,
      callerE164: wt.callerE164,
      recipientE164: wt.recipientE164,
      outcome: "success",
      dedupeKey
    });
    // Record ANSWERED at the bridge, not just at hangup: the eventual hangup
    // can carry a non-normal_clearing cause even though the human answered,
    // and this row is what blocks that hangup's insert-only `missed` write
    // (see forwarded_call_log.ts precedence). The hangup's answered upsert
    // then refreshes ended_at with the real call end.
    await logForwardedCallOutcome(deps, {
      businessId: wt.businessId,
      callControlId: legId,
      callerE164: wt.callerE164 || null,
      forwardedToE164: wt.recipientE164 || null,
      startedAtIso: String(payload["start_time"] ?? "") || null,
      outcome: "answered",
      context: "warm_transfer"
    });
    return { handled: true, response: jsonOk("wt_bridged") };
  }

  // call.hangup on the transfer leg. A normal_clearing cause means the recipient
  // answered and the call completed → send SUCCESS as defence in depth for a
  // dropped call.bridged. The shared dedup key means this is a no-op when
  // call.bridged already sent success. Any other cause = no-answer → FAILURE
  // (also blocked by the shared key if success already went out).
  const cause = String(payload["hangup_cause"] ?? "").toLowerCase();
  const answered = cause === "normal_clearing";
  await sendWarmTransferNotifications(deps.supabase, deps.apiKey, {
    businessId: wt.businessId,
    callerE164: wt.callerE164,
    recipientE164: wt.recipientE164,
    outcome: answered ? "success" : "failed",
    dedupeKey
  });
  // Terminal record. normal_clearing → answered upsert (refreshes ended_at to
  // the real call end over the bridged-time row). Any other cause → missed,
  // but insert-only: if call.bridged already recorded answered, the missed
  // write is superseded and the follow-ups are skipped, the cause alone is
  // not proof nobody answered. Missed → caller auto-text + blocked ledger +
  // spike.
  const recStatus = await logForwardedCallOutcome(deps, {
    businessId: wt.businessId,
    callControlId: legId,
    callerE164: wt.callerE164 || null,
    forwardedToE164: wt.recipientE164 || null,
    startedAtIso: String(payload["start_time"] ?? "") || null,
    outcome: answered ? "answered" : "missed",
    context: "warm_transfer"
  });
  // Meter the human leg's carrier time against the tenant's voice pool.
  // Nothing is exempt from metering: the platform pays Telnyx for this leg's
  // full duration whether the AI or a human did the talking. Every single-leg
  // transfer path funnels through here (AI transfer_to_owner, caller-rule
  // transfers, safe-mode forwards), so this one hook covers them all. Metered
  // when the human answered, including the `superseded` reorder case (a
  // non-normal_clearing hangup after call.bridged recorded the answer).
  // Missed legs bill nothing (the carrier doesn't charge unanswered legs).
  // Post-hoc and idempotent per leg; never refuses, the reserve gate and the
  // safe-mode pre-check refuse the NEXT call once the pool is spent.
  if (answered || recStatus === "superseded") {
    await meterForwardedCallSeconds(deps.supabase, {
      businessId: wt.businessId,
      callControlId: legId,
      reportedSeconds: parseCallDurationSeconds(payload),
      context: "warm_transfer"
    });
  }
  return {
    handled: true,
    response: jsonOk(answered ? "wt_answered_hangup" : "wt_failed")
  };
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
  // Answering-machine detection on an AiFlow-placed call. Runs before the
  // handlers below because a machine verdict SHORTENS the call: without it the
  // AI would hold a conversation with a voicemail for the full session and the
  // hangup would then report "answered", stopping any follow-up ladder on a
  // lead who never heard a word.
  if (isAmdEvent(eventType)) {
    return await handleMachineDetection(supabase, eventType, data?.payload ?? {});
  }

  // The end of a voicemail message we spoke, so the leg can be released.
  if (eventType === "call.speak.ended") {
    return await handleSpeakEnded(supabase, data?.payload ?? {});
  }

  // A "reach a teammate" B leg. Recorded before the outbound handler so a leg
  // the assistant dialed to FIND someone is never mistaken for the callee's own
  // leg and handed an AI bridge.
  if (eventType === "call.answered" || eventType === "call.hangup") {
    const reach = await handleReachLeg(supabase, eventType, data?.payload ?? {});
    if (reach) return reach;
  }

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
    // Single-leg warm transfers (receptionist + caller-rule) tag their B leg
    // with a `wt:` client_state; the handoff handler ignores those, so fire the
    // warm-transfer SMS notifications here.
    const wt = await handleWarmTransferLifecycle(handoffDeps, eventType, data?.payload ?? {});
    if (wt.handled) return wt.response;
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
