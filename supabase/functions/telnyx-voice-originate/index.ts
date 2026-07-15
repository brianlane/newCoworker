/**
 * Telnyx Programmable Voice: OUTBOUND origination for an `outbound_call` AiFlow
 * (and, via a per-call payload, a batch flow's `place_ai_call` step).
 *
 * Invoked server-to-server (NOT by Telnyx) from the app's "Place call" action
 * (src/app/api/aiflows/[id]/place-call), from the ai-flow-worker schedule
 * sweep for scheduled outbound flows, AND from the ai-flow-worker's
 * place_ai_call step executor (which sends a fully-resolved `call` payload —
 * callee, persona, notify, transfer config, parked-run link — instead of
 * reading an outbound_call step). It validates the outbound voice flow,
 * runs a READ-ONLY pre-dial budget probe (so an over-budget tenant's callee is
 * never even rung), dials the callee, then RESERVES voice budget under the real
 * call_control_id BEFORE any media. If the reservation is refused (over budget /
 * concurrency), it hangs the leg up before answer so no minutes are billed. The
 * post-dial reserve is the AUTHORITATIVE gate; the pre-dial probe is a
 * best-effort optimization. It also writes a
 * voice_handoff_sessions row (status=ai_intake) carrying the step's persona /
 * capture fields / notify number so the VPS bridge runs the configured outbound
 * AI and texts the post-call summary. The AI bridge is attached later by
 * telnyx-voice-call-end on the call.answered webhook (the dispatcher routes
 * call.answered there); this function never touches media.
 *
 * Metering is therefore a system-level invariant for outbound exactly as for
 * inbound: the same voice_reserve_for_call RPC + the same settlement lifecycle.
 *
 * Response contract: success is { ok:true, callControlId, ... }. Every refusal
 * is { ok:false, error/reason, ... } and carries `dialed: false` when the callee
 * was NEVER rung (auth/validation/config refusals and the pre-dial budget
 * block) so a scheduled caller may safely retry the occurrence; refusals that
 * happen AFTER the dial (post-dial budget refusal, lost call id,
 * session_persist_failed) omit `dialed` and must NOT be retried.
 *
 * Auth: Authorization: Bearer <INTERNAL_CRON_SECRET> (assertCronAuth) — the
 * shared server-to-server secret. Callers are our own Next.js Place-call route
 * (which already authenticated the owner) and the ai-flow-worker schedule
 * sweep. No public access. (We deliberately do NOT authenticate against
 * SUPABASE_SERVICE_ROLE_KEY: the platform-injected service-role key can differ
 * from the one callers hold under the new API-key system.)
 *
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELNYX_API_KEY, INTERNAL_CRON_SECRET.
 * Optional: STRIPE_SECRET_KEY (JIT period refresh), VOICE_AI_STREAM_ENABLED.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telnyxDialCall, telnyxHangupCall } from "../_shared/telnyx_call_actions.ts";
import { checkVoiceBudgetAvailable, reserveVoiceBudget } from "../_shared/voice_reserve.ts";
import { normalizeE164 } from "../_shared/normalize_e164.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { systemLog } from "../_shared/system_log.ts";
import {
  encodeOutboundClientState,
  outboundSessionContext,
  parsePlaceCallPayload,
  resolveOutboundCallPlan
} from "../_shared/voice_outbound.ts";
import type { AiFlowDefinition } from "../_shared/ai_flows/types.ts";
import { resolveVoiceContactRefs } from "../_shared/ai_flows/contact_ref.ts";

const MAX_BODY = 16 * 1024;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function envVoiceAiStreamEnabled(): boolean {
  const v = (Deno.env.get("VOICE_AI_STREAM_ENABLED") ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const apiKey = Deno.env.get("TELNYX_API_KEY") ?? "";
  if (!supabaseUrl || !serviceKey || !apiKey) {
    console.error("telnyx-voice-originate: missing env");
    return new Response("Server misconfigured", { status: 500 });
  }

  // Caller auth: the shared INTERNAL_CRON_SECRET bearer (assertCronAuth), the
  // same server-to-server secret the worker sweep is itself authed with. We do
  // NOT compare against SUPABASE_SERVICE_ROLE_KEY: on projects using the new API
  // key / JWT-signing-key system the platform injects a service-role key into
  // the function that differs from the legacy service_role key external callers
  // (the Next.js Place-call route, this worker) hold, so that compare 401s every
  // real caller. serviceKey below is still used for the privileged DB client.
  if (!(await assertCronAuth(req))) {
    return json(401, { ok: false, error: "unauthorized", dialed: false });
  }

  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY) {
    return new Response("Body too large", { status: 413 });
  }
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) {
    return new Response("Body too large", { status: 413 });
  }

  let body: { businessId?: unknown; flowId?: unknown; toE164?: unknown; call?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json(400, { ok: false, error: "bad_json", dialed: false });
  }
  const businessId = typeof body.businessId === "string" ? body.businessId.trim() : "";
  const flowId = typeof body.flowId === "string" ? body.flowId.trim() : "";
  if (!businessId || !flowId) {
    return json(422, { ok: false, error: "missing_business_or_flow", dialed: false });
  }

  if (!envVoiceAiStreamEnabled()) {
    return json(409, { ok: false, error: "voice_ai_disabled", dialed: false });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Load the flow. Two caller shapes:
  //   - outbound VOICE flow ("Place call" / schedule sweep): the plan is read
  //     from the flow's single outbound_call step;
  //   - batch flow place_ai_call step (ai-flow-worker): the plan arrives fully
  //     resolved in `body.call` (callee, persona, notify, transfer, run link)
  //     — the flow row is still checked (exists, this business, enabled) so a
  //     disabled/deleted flow can never keep placing calls.
  const { data: flowRow, error: flowErr } = await supabase
    .from("ai_flows")
    .select("id, definition, enabled")
    .eq("id", flowId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (flowErr) {
    console.error("originate: flow lookup", flowErr);
    return json(500, { ok: false, error: "flow_lookup_failed", dialed: false });
  }
  const flow = flowRow as { definition?: unknown; enabled?: boolean } | null;
  if (!flow) return json(404, { ok: false, error: "flow_not_found", dialed: false });
  if (flow.enabled !== true) return json(409, { ok: false, error: "flow_disabled", dialed: false });

  const plan = await (async () => {
    if (body.call !== undefined) {
      // Per-call payload (place_ai_call). A malformed payload is a caller
      // bug — refuse (dialed:false) rather than dialing a half-read config.
      return parsePlaceCallPayload(body.call);
    }
    try {
      // Resolve dynamic contact refs (toRef/notifyRef → live numbers) BEFORE
      // the pure plan reader runs (resolve-before-compile).
      const resolvedDef = await resolveVoiceContactRefs(
        supabase,
        businessId,
        flow.definition as AiFlowDefinition
      );
      return resolveOutboundCallPlan(resolvedDef);
    } catch (e) {
      console.error("originate: resolveOutboundCallPlan", e);
      return null;
    }
  })();
  if (!plan) {
    return json(422, {
      ok: false,
      error: body.call !== undefined ? "bad_call_payload" : "not_an_outbound_flow",
      dialed: false
    });
  }

  // Callee: per-call override wins, else the step default.
  const overrideTo = typeof body.toE164 === "string" ? body.toE164 : "";
  const callee = normalizeE164(overrideTo || plan.toE164);
  if (!callee) return json(422, { ok: false, error: "invalid_callee", dialed: false });

  // Caller ID + connection: the business's own DID (a telnyx_voice_routes row)
  // presented as `from`, dialed on its Call Control connection.
  const [{ data: settingsRow }, { data: routeRow }] = await Promise.all([
    supabase
      .from("business_telnyx_settings")
      .select("telnyx_connection_id")
      .eq("business_id", businessId)
      .maybeSingle(),
    supabase
      .from("telnyx_voice_routes")
      .select("to_e164")
      .eq("business_id", businessId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()
  ]);
  const connectionId = (settingsRow as { telnyx_connection_id?: string | null } | null)
    ?.telnyx_connection_id;
  const fromDid = (routeRow as { to_e164?: string | null } | null)?.to_e164;
  if (!connectionId) return json(422, { ok: false, error: "no_telnyx_connection", dialed: false });
  if (!fromDid) return json(422, { ok: false, error: "no_caller_id", dialed: false });

  // Pre-dial budget gate (honor "metered before spend" before a leg exists).
  // voice_reserve_for_call keys a reservation by a Telnyx call_control_id, which
  // only exists once dialing starts; so we probe the read-only availability RPC
  // first and NEVER ring the callee for an over-budget tenant. This is
  // best-effort: an `indeterminate` result (stale/missing cached period, etc.)
  // falls through to the dial because the post-dial reserve below — which does
  // the authoritative JIT period refresh — is the real gate, and it hangs the
  // leg up before answer so a slip-through is never billed.
  const availability = await checkVoiceBudgetAvailable(supabase, { businessId });
  if (availability.status === "blocked") {
    await telemetryRecord(supabase, "voice_outbound_blocked", {
      business_id: businessId,
      flow_id: flowId,
      reason: availability.reason,
      phase: "pre_dial"
    });
    await systemLog(supabase, {
      businessId,
      source: "voice",
      level: "warn",
      event: "voice_outbound_blocked",
      message: `Outbound call not placed (pre-dial): ${availability.reason}`,
      payload: { reason: availability.reason, to: callee, phase: "pre_dial" }
    });
    // dialed:false — the callee was never rung, so a scheduled caller may safely
    // retry this occurrence later (budget may free up within its window).
    return json(200, { ok: false, error: "budget", reason: availability.reason, dialed: false });
  }

  const sessionId = crypto.randomUUID();
  const clientState = encodeOutboundClientState(businessId, sessionId);

  // Dial first — the originated leg's events (answered/hangup) return to the
  // shared voice webhook and drive the call-control machine.
  const dialRes = await telnyxDialCall(apiKey, {
    connectionId,
    to: callee,
    from: fromDid,
    timeoutSecs: 30,
    clientState,
    commandId: sessionId
  });
  if (!dialRes.ok) {
    const errText = (await dialRes.text()).slice(0, 300);
    console.error("originate: dial failed", dialRes.status, errText);
    await telemetryRecord(supabase, "voice_outbound_dial_failed", {
      business_id: businessId,
      flow_id: flowId,
      http_status: dialRes.status
    });
    // dialed:false — Telnyx rejected POST /v2/calls so NO call leg was created
    // and the callee was not rung; a scheduled caller may safely retry.
    return json(502, { ok: false, error: "dial_failed", http_status: dialRes.status, dialed: false });
  }
  const dialJson = (await dialRes.json().catch(() => null)) as
    | { data?: { call_control_id?: string } }
    | null;
  const callControlId = dialJson?.data?.call_control_id ?? "";
  if (!callControlId) {
    // Telnyx's POST /v2/calls always returns data.call_control_id on a 2xx, so
    // this is a defensive branch. Without the id we cannot hang up, reserve, or
    // write a session for this leg directly — but it was dialed with our `vob:`
    // client_state, so if it ever materializes it self-identifies on every
    // webhook: a call.answered hits handleOutboundAnswered, finds no `ai_intake`
    // session (we never wrote one), and hangs the leg up; a no-answer rings out
    // and settles with no reservation to leak. Log for visibility, then fail.
    console.error("originate: dial response missing call_control_id", dialJson);
    await telemetryRecord(supabase, "voice_outbound_dial_no_call_control_id", {
      business_id: businessId,
      flow_id: flowId
    });
    return json(502, { ok: false, error: "no_call_control_id" });
  }

  // Reserve budget under the REAL leg id BEFORE we make the leg bridgeable. The
  // reservation is the AUTHORITATIVE budget gate: only after it succeeds do we
  // write the `ai_intake` session that lets call.answered attach the AI bridge.
  // On refusal we never write a session, so a racing call.answered finds no
  // active intake session and hangs up — the refused call can never be metered
  // or bridged behind the UI's back.
  const reserve = await reserveVoiceBudget(supabase, {
    businessId,
    callControlId,
    stripeSecret: Deno.env.get("STRIPE_SECRET_KEY") ?? ""
  });
  if (!reserve.ok) {
    try {
      await telnyxHangupCall(apiKey, callControlId);
    } catch (e) {
      console.error("originate: hangup after refused reservation failed", e);
    }
    await telemetryRecord(supabase, "voice_outbound_blocked", {
      business_id: businessId,
      flow_id: flowId,
      call_control_id: callControlId,
      reason: reserve.reason
    });
    await systemLog(supabase, {
      businessId,
      source: "voice",
      level: "warn",
      event: "voice_outbound_blocked",
      message: `Outbound call refused: ${reserve.reason}`,
      payload: { call_control_id: callControlId, reason: reserve.reason, to: callee }
    });
    return json(200, { ok: false, error: "budget", reason: reserve.reason });
  }

  // Budget held → make the leg bridgeable. The VPS bridge reads this row by
  // call_control_id on connect to switch into intake mode (run the configured
  // persona, capture the configured fields, text the post-call summary to
  // notifyE164). Because we only reach here AFTER a successful reservation,
  // `status='ai_intake'` is the single signal call.answered needs that the leg
  // is both budgeted and configured.
  const { error: sessErr } = await supabase.from("voice_handoff_sessions").upsert(
    {
      call_control_id: callControlId,
      business_id: businessId,
      from_e164: callee,
      chain_from_e164: callee,
      status: "ai_intake",
      current_step: 0,
      context: { ...outboundSessionContext(plan), session_id: sessionId }
    },
    { onConflict: "call_control_id" }
  );
  if (sessErr) {
    // The intake session IS the call's config: without it the bridge runs the
    // default receptionist and never texts the summary, so reporting success
    // would silently place a misconfigured call. Abort: release the reservation
    // we just made (so we don't hold a slot for a dead leg) and hang up.
    console.error("originate: intake session upsert failed; aborting", sessErr);
    const { error: relErr } = await supabase.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    if (relErr) console.error("originate: release reservation after session fail failed", relErr);
    try {
      await telnyxHangupCall(apiKey, callControlId);
    } catch (e) {
      console.error("originate: hangup after session upsert failure failed", e);
    }
    await telemetryRecord(supabase, "voice_outbound_session_upsert_failed", {
      business_id: businessId,
      flow_id: flowId,
      call_control_id: callControlId
    });
    return json(500, { ok: false, error: "session_persist_failed" });
  }

  await telemetryRecord(supabase, "voice_outbound_originated", {
    business_id: businessId,
    flow_id: flowId,
    call_control_id: callControlId
  });
  await systemLog(supabase, {
    businessId,
    source: "voice",
    level: "info",
    event: "voice_outbound_originated",
    message: `Placed outbound AI call to ${callee} (flow ${flowId})`,
    payload: { call_control_id: callControlId, to: callee, from: fromDid }
  });

  return json(200, { ok: true, callControlId, sessionId, to: callee });
});
