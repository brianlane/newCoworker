/**
 * Telnyx Programmable Voice: OUTBOUND origination for an `outbound_call` AiFlow.
 *
 * Invoked server-to-server (NOT by Telnyx) from the app's "Place call" action
 * (src/app/api/aiflows/[id]/place-call). It validates the outbound voice flow,
 * dials the callee, then RESERVES voice budget under the real call_control_id
 * BEFORE any media. If the reservation is refused (over budget / concurrency),
 * it hangs the leg up before answer so no minutes are billed. It also writes a
 * voice_handoff_sessions row (status=ai_intake) carrying the step's persona /
 * capture fields / notify number so the VPS bridge runs the configured outbound
 * AI and texts the post-call summary. The AI bridge is attached later by
 * telnyx-voice-call-end on the call.answered webhook (the dispatcher routes
 * call.answered there); this function never touches media.
 *
 * Metering is therefore a system-level invariant for outbound exactly as for
 * inbound: the same voice_reserve_for_call RPC + the same settlement lifecycle.
 *
 * Auth: Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>. The caller is our own
 * Next.js server route (which already authenticated the owner). No public access.
 *
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELNYX_API_KEY.
 * Optional: STRIPE_SECRET_KEY (JIT period refresh), VOICE_AI_STREAM_ENABLED.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { telnyxDialCall, telnyxHangupCall } from "../_shared/telnyx_call_actions.ts";
import { reserveVoiceBudget } from "../_shared/voice_reserve.ts";
import { normalizeE164 } from "../_shared/normalize_e164.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { systemLog } from "../_shared/system_log.ts";
import {
  encodeOutboundClientState,
  outboundSessionContext,
  resolveOutboundCallPlan
} from "../_shared/voice_outbound.ts";
import type { AiFlowDefinition } from "../_shared/ai_flows/types.ts";

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

/** Constant-time-ish bearer compare (avoids early-exit length leak on the token). */
function bearerMatches(header: string | null, expected: string): boolean {
  if (!header || !expected) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const token = header.slice(prefix.length);
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
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

  if (!bearerMatches(req.headers.get("authorization"), serviceKey)) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY) {
    return new Response("Body too large", { status: 413 });
  }
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) {
    return new Response("Body too large", { status: 413 });
  }

  let body: { businessId?: unknown; flowId?: unknown; toE164?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json(400, { ok: false, error: "bad_json" });
  }
  const businessId = typeof body.businessId === "string" ? body.businessId.trim() : "";
  const flowId = typeof body.flowId === "string" ? body.flowId.trim() : "";
  if (!businessId || !flowId) {
    return json(422, { ok: false, error: "missing_business_or_flow" });
  }

  if (!envVoiceAiStreamEnabled()) {
    return json(409, { ok: false, error: "voice_ai_disabled" });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Load the flow and confirm it is an enabled OUTBOUND voice flow with a usable
  // outbound_call step.
  const { data: flowRow, error: flowErr } = await supabase
    .from("ai_flows")
    .select("id, definition, enabled")
    .eq("id", flowId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (flowErr) {
    console.error("originate: flow lookup", flowErr);
    return json(500, { ok: false, error: "flow_lookup_failed" });
  }
  const flow = flowRow as { definition?: unknown; enabled?: boolean } | null;
  if (!flow) return json(404, { ok: false, error: "flow_not_found" });
  if (flow.enabled !== true) return json(409, { ok: false, error: "flow_disabled" });

  const plan = (() => {
    try {
      return resolveOutboundCallPlan(flow.definition as AiFlowDefinition);
    } catch (e) {
      console.error("originate: resolveOutboundCallPlan", e);
      return null;
    }
  })();
  if (!plan) return json(422, { ok: false, error: "not_an_outbound_flow" });

  // Callee: per-call override wins, else the step default.
  const overrideTo = typeof body.toE164 === "string" ? body.toE164 : "";
  const callee = normalizeE164(overrideTo || plan.toE164);
  if (!callee) return json(422, { ok: false, error: "invalid_callee" });

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
  if (!connectionId) return json(422, { ok: false, error: "no_telnyx_connection" });
  if (!fromDid) return json(422, { ok: false, error: "no_caller_id" });

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
    return json(502, { ok: false, error: "dial_failed", http_status: dialRes.status });
  }
  const dialJson = (await dialRes.json().catch(() => null)) as
    | { data?: { call_control_id?: string } }
    | null;
  const callControlId = dialJson?.data?.call_control_id ?? "";
  if (!callControlId) {
    console.error("originate: dial response missing call_control_id", dialJson);
    return json(502, { ok: false, error: "no_call_control_id" });
  }

  // Persist the intake session FIRST (before the reservation, which may do a
  // slow Stripe JIT refresh). The VPS bridge reads this row by call_control_id
  // on connect to switch into intake mode — run the configured persona, capture
  // the configured fields, and text the post-call summary to notifyE164. Writing
  // it immediately after the dial (tens of ms) keeps it in place well before the
  // callee can answer, so the bridge never falls back to the receptionist.
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
    // Non-fatal for billing, but the bridge would run the default persona and
    // skip the summary SMS — surface it loudly so a misconfig is visible.
    console.error("originate: intake session upsert failed", sessErr);
    await telemetryRecord(supabase, "voice_outbound_session_upsert_failed", {
      business_id: businessId,
      flow_id: flowId,
      call_control_id: callControlId
    });
  }

  // Reserve budget under the REAL leg id BEFORE any answer/media. The callee can
  // only ring in the brief window before this resolves; on refusal we hang up
  // before answer so no minutes are billed.
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
    // The leg is being torn down — mark the intake session terminal so a stray
    // late answer can't connect the bridge to an unmetered call.
    const { error: doneErr } = await supabase
      .from("voice_handoff_sessions")
      .update({ status: "done" })
      .eq("call_control_id", callControlId);
    if (doneErr) console.error("originate: mark session done after refusal failed", doneErr);
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
