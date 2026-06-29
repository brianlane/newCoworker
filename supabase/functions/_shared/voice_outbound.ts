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

/** Config resolved from a flow's single outbound_call step. */
export type OutboundCallPlan = {
  /** Default callee (may be overridden per placed call). Empty when unset. */
  toE164: string;
  /** Where the post-call summary + transcript text is sent. */
  notifyE164: string;
  persona: string | null;
  captureFields: string[] | null;
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
