/**
 * Pure helpers for OUTBOUND voice origination (an `outbound_call` AiFlow step).
 *
 * The origination edge function (telnyx-voice-originate) dials the callee and
 * the call.answered handler (telnyx-voice-call-end) attaches the Gemini bridge.
 * Both correlate the leg through a `client_state` we stamp on the dial. The
 * branch-free decisions — how to encode/parse that client_state and how to read
 * the single outbound_call step out of a flow definition — live here so they can
 * be unit-tested under Node/Vitest without a live call. Dependency-free
 * (btoa/atob only), mirroring voice_handoff.ts.
 *
 * client_state format: `vob:<businessId>:<sessionId>`.
 *   - `vob` prefix is deliberately distinct from the handoff chain's `hl:` so
 *     parseHandoffClientState() returns null for outbound legs and call-end's
 *     hangup path falls through to normal settlement (receptionist parity).
 *   - businessId lets the answered handler build the signed stream URL without a
 *     DB session row; sessionId makes each placed call's state unique/idempotent.
 */
import type { AiFlowDefinition, FlowStep } from "./ai_flows/types.ts";

export const OUTBOUND_CS_PREFIX = "vob";

/**
 * Live-transfer config carried on a per-call (place_ai_call) origination: the
 * bridge registers a transfer tool that texts `preSmsBody` to the target and
 * warm-transfers the live callee to `toE164`. Numbers are fully resolved by
 * the worker before origination (the edge never sees a ContactRef).
 */
export type OutboundCallTransfer = {
  toE164: string;
  /** Pre-rendered pre-alert SMS body ("" / absent = no pre-alert). */
  preSmsBody?: string;
  /** Display name the AI speaks ("one moment while I get Dave on the line"). */
  agentName?: string;
};

/**
 * Link back to the parked ai_flow_runs row a place_ai_call step created, so
 * the voice path (bridge transfer tool, call-end hangup handler) can resume
 * the run with the call outcome.
 */
export type OutboundFlowRunLink = {
  runId: string;
  /** context.vars key that receives the outcome. */
  saveAs: string;
  /** Per-step resolution marker stamped alongside the outcome. */
  marker: string;
  stepIndex: number;
};

/** Config resolved from a flow's single outbound_call step (or a per-call payload). */
export type OutboundCallPlan = {
  /** Default callee (may be overridden per placed call). Empty when unset. */
  toE164: string;
  /** Where the post-call summary + transcript text is sent. */
  notifyE164: string;
  persona: string | null;
  /** place_ai_call only: rendered known-details note for the call prompt. */
  contextNote?: string;
  captureFields: string[] | null;
  /** place_ai_call only: live-transfer config. */
  transfer?: OutboundCallTransfer;
  /** place_ai_call only: the parked run to resume with the outcome. */
  flowRun?: OutboundFlowRunLink;
};

/** Plain-text client_state stamped on the dial: `vob:<businessId>:<sessionId>`. */
export function encodeOutboundClientState(businessId: string, sessionId: string): string {
  return `${OUTBOUND_CS_PREFIX}:${businessId}:${sessionId}`;
}

/**
 * Parse the client_state echoed on an outbound leg's webhook. Telnyx returns
 * client_state base64-encoded, so decode first when it isn't already the plain
 * `vob:...` form (covers both real webhooks and direct unit tests). Returns null
 * for anything that is not a well-formed outbound state (e.g. a handoff `hl:`
 * leg or an inbound answer with no client_state).
 */
export function parseOutboundClientState(
  raw: string | null | undefined
): { businessId: string; sessionId: string } | null {
  if (!raw) return null;
  let text = raw;
  if (!text.startsWith(`${OUTBOUND_CS_PREFIX}:`)) {
    try {
      text = atob(raw);
    } catch {
      return null;
    }
  }
  // businessId + sessionId are uuids (no colon), so a strict 3-part match is
  // unambiguous. Reject empty segments.
  const m = /^vob:([^:]+):([^:]+)$/.exec(text);
  if (!m) return null;
  return { businessId: m[1]!, sessionId: m[2]! };
}

/**
 * Read the single outbound_call step out of an outbound voice flow definition.
 * Returns null when the definition is not an outbound voice flow or has no
 * usable outbound_call step (notifyE164 is required for the summary text).
 */
export function resolveOutboundCallPlan(def: AiFlowDefinition): OutboundCallPlan | null {
  if (!def || def.trigger?.channel !== "voice" || def.trigger?.direction !== "outbound") {
    return null;
  }
  const steps: FlowStep[] = Array.isArray(def.steps) ? def.steps : [];
  const step = steps.find(
    (s): s is Extract<FlowStep, { type: "outbound_call" }> => s.type === "outbound_call"
  );
  if (!step) return null;
  const notify = typeof step.notifyE164 === "string" ? step.notifyE164.trim() : "";
  if (!notify) return null;
  const to = typeof step.toE164 === "string" ? step.toE164.trim() : "";
  const persona = typeof step.persona === "string" && step.persona.trim() ? step.persona.trim() : null;
  const captureFields =
    Array.isArray(step.captureFields) && step.captureFields.length > 0
      ? step.captureFields.map((f) => String(f)).filter((f) => f.trim().length > 0)
      : null;
  return {
    toE164: to,
    notifyE164: notify,
    persona,
    captureFields: captureFields && captureFields.length > 0 ? captureFields : null
  };
}

/** voice_handoff_sessions.context for an outbound AI call (intake mode). */
export type OutboundSessionContext = {
  /** Distinguishes an outbound-placed session from a HomeLight inbound takeover. */
  outbound: true;
  /** Same shape the VPS bridge reads for HomeLight intake mode. */
  ai_takeover: {
    notify_e164: string;
    persona?: string;
    capture_fields?: string[];
    /** Known details about the callee, injected with a never-re-ask rule. */
    context_note?: string;
  };
  /** place_ai_call only: the bridge registers a live-transfer tool from this. */
  transfer?: {
    to_e164: string;
    pre_sms_body?: string;
    agent_name?: string;
  };
  /** place_ai_call only: the parked run the voice path resumes with the outcome. */
  flow_run?: {
    run_id: string;
    save_as: string;
    marker: string;
    step_index: number;
  };
};

/**
 * Build the `voice_handoff_sessions.context` for an outbound AI call so the VPS
 * bridge switches into intake mode exactly like a HomeLight `ai_takeover`: it
 * runs the configured persona, captures the configured fields, and texts the
 * post-call summary + transcript to `notify_e164`. Without this the bridge finds
 * no `ai_takeover` context and falls back to the default receptionist persona
 * (and never sends the summary), so the outbound flow's whole purpose is lost.
 * A place_ai_call plan additionally carries the transfer config and the parked
 * run link so the voice path can transfer + resume.
 */
export function outboundSessionContext(plan: OutboundCallPlan): OutboundSessionContext {
  const ai_takeover: OutboundSessionContext["ai_takeover"] = { notify_e164: plan.notifyE164 };
  if (plan.persona) ai_takeover.persona = plan.persona;
  if (plan.captureFields && plan.captureFields.length > 0) {
    ai_takeover.capture_fields = plan.captureFields;
  }
  if (plan.contextNote) ai_takeover.context_note = plan.contextNote;
  const ctx: OutboundSessionContext = { outbound: true, ai_takeover };
  if (plan.transfer) {
    ctx.transfer = {
      to_e164: plan.transfer.toE164,
      ...(plan.transfer.preSmsBody ? { pre_sms_body: plan.transfer.preSmsBody } : {}),
      ...(plan.transfer.agentName ? { agent_name: plan.transfer.agentName } : {})
    };
  }
  if (plan.flowRun) {
    ctx.flow_run = {
      run_id: plan.flowRun.runId,
      save_as: plan.flowRun.saveAs,
      marker: plan.flowRun.marker,
      step_index: plan.flowRun.stepIndex
    };
  }
  return ctx;
}

/**
 * Parse + validate a per-call origination payload (the `call` object a
 * place_ai_call worker step POSTs to telnyx-voice-originate) into an
 * OutboundCallPlan. Returns null when the payload is not usable — a
 * malformed internal call is a caller bug, and dialing with a half-read
 * config (e.g. a dropped transfer) would silently run the wrong call.
 */
export function parsePlaceCallPayload(raw: unknown): OutboundCallPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const toE164 = typeof c.toE164 === "string" ? c.toE164.trim() : "";
  const notifyE164 = typeof c.notifyE164 === "string" ? c.notifyE164.trim() : "";
  if (!toE164 || !notifyE164) return null;
  const persona = typeof c.persona === "string" && c.persona.trim() ? c.persona.trim() : null;
  const captureFields = Array.isArray(c.captureFields)
    ? c.captureFields.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    : null;
  const plan: OutboundCallPlan = {
    toE164,
    notifyE164,
    persona,
    captureFields: captureFields && captureFields.length > 0 ? captureFields : null
  };
  if (typeof c.contextNote === "string" && c.contextNote.trim()) {
    plan.contextNote = c.contextNote.trim();
  }
  if (c.transfer !== undefined) {
    const t = c.transfer as Record<string, unknown> | null;
    const transferTo = t && typeof t.toE164 === "string" ? t.toE164.trim() : "";
    if (!transferTo) return null;
    plan.transfer = {
      toE164: transferTo,
      ...(typeof t!.preSmsBody === "string" && t!.preSmsBody.trim()
        ? { preSmsBody: t!.preSmsBody.trim() }
        : {}),
      ...(typeof t!.agentName === "string" && t!.agentName.trim()
        ? { agentName: t!.agentName.trim() }
        : {})
    };
  }
  if (c.flowRun !== undefined) {
    const f = c.flowRun as Record<string, unknown> | null;
    const runId = f && typeof f.runId === "string" ? f.runId.trim() : "";
    const saveAs = f && typeof f.saveAs === "string" ? f.saveAs.trim() : "";
    const marker = f && typeof f.marker === "string" ? f.marker.trim() : "";
    const stepIndex = f && typeof f.stepIndex === "number" ? f.stepIndex : NaN;
    if (!runId || !saveAs || !marker || !Number.isInteger(stepIndex) || stepIndex < 0) {
      return null;
    }
    plan.flowRun = { runId, saveAs, marker, stepIndex };
  }
  return plan;
}
