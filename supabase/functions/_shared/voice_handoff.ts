/**
 * Pure helpers for the voice warm-handoff chain (HomeLight live transfer).
 *
 * The state machine itself lives in telnyx-voice-inbound (it needs Telnyx +
 * Supabase), but the branch-free decisions — how to encode/parse the transfer
 * client_state and which step to try next — are isolated here so they can be
 * unit-tested without a live call. Imported by both the Deno edge function and
 * the Vitest suite, so this file must stay dependency-free (btoa/atob only).
 */

export type HandoffStep = { to_e164: string; ring_secs: number };

export type HandoffAiTakeover = {
  notify_e164: string;
  persona?: string;
  capture_fields?: string[];
};

/** Resolved chain snapshot stored on the session row's `context`. */
export type HandoffContext = {
  to_e164: string;
  steps: HandoffStep[];
  ai_takeover: HandoffAiTakeover | null;
};

export const HANDOFF_CS_PREFIX = "hl";

/** Plain-text client_state we attach to each transfer leg: `hl:<aLegCallId>:<step>`. */
export function encodeHandoffClientState(aLegCallId: string, step: number): string {
  return `${HANDOFF_CS_PREFIX}:${aLegCallId}:${step}`;
}

/**
 * Parse the client_state echoed on a transfer leg's webhook. Telnyx returns
 * client_state base64-encoded, so we decode first when it isn't already the
 * plain `hl:...` form (covers both real webhooks and direct unit tests).
 */
export function parseHandoffClientState(
  raw: string | null | undefined
): { aLegCallId: string; step: number } | null {
  if (!raw) return null;
  let text = raw;
  if (!text.startsWith(`${HANDOFF_CS_PREFIX}:`)) {
    try {
      text = atob(raw);
    } catch {
      return null;
    }
  }
  // aLegCallId can itself contain ':'; anchor on the trailing `:<digits>` and
  // treat everything between the prefix and that as the call id. The `\d+`
  // group guarantees a non-negative integer step.
  const m = /^hl:(.+):(\d+)$/.exec(text);
  if (!m) return null;
  return { aLegCallId: m[1]!, step: Number(m[2]) };
}

export type HandoffAdvance =
  | { kind: "transfer"; step: number; toE164: string; ringSecs: number }
  | { kind: "ai_takeover" }
  | { kind: "hangup" };

/**
 * Decide what to do after `failedStep` rang out with no answer:
 *   - ring the next human step if there is one,
 *   - otherwise hand to the AI worker if a takeover is configured,
 *   - otherwise hang up.
 */
export function planHandoffAdvance(args: {
  steps: HandoffStep[];
  failedStep: number;
  hasAiTakeover: boolean;
}): HandoffAdvance {
  const next = args.failedStep + 1;
  // `steps` is pre-validated by buildHandoffContext (non-empty to_e164 only).
  const step = args.steps[next];
  if (step) {
    const ringSecs = step.ring_secs > 0 ? Math.floor(step.ring_secs) : 20;
    return { kind: "transfer", step: next, toE164: step.to_e164, ringSecs };
  }
  if (args.hasAiTakeover) return { kind: "ai_takeover" };
  return { kind: "hangup" };
}

/**
 * Coerce a step's `ring_secs` to a positive integer, defaulting to 20. JSONB
 * values can arrive as numbers OR numeric strings (e.g. `"45"`), so accept both;
 * anything non-finite or <= 0 falls back to the 20s default.
 */
export function coerceRingSecs(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

/** Normalize a raw chain row's `steps`/`ai_takeover` into a typed context. */
export function buildHandoffContext(input: {
  toE164: string;
  steps: unknown;
  aiTakeover: unknown;
}): HandoffContext {
  const steps: HandoffStep[] = Array.isArray(input.steps)
    ? (input.steps as unknown[])
        .map((s) => {
          const o = (s ?? {}) as Record<string, unknown>;
          const to = typeof o.to_e164 === "string" ? o.to_e164 : "";
          return { to_e164: to, ring_secs: coerceRingSecs(o.ring_secs) };
        })
        .filter((s) => s.to_e164.length > 0)
    : [];
  let ai: HandoffAiTakeover | null = null;
  if (input.aiTakeover && typeof input.aiTakeover === "object") {
    const o = input.aiTakeover as Record<string, unknown>;
    const notify = typeof o.notify_e164 === "string" ? o.notify_e164 : "";
    if (notify) {
      ai = {
        notify_e164: notify,
        persona: typeof o.persona === "string" ? o.persona : undefined,
        capture_fields: Array.isArray(o.capture_fields)
          ? (o.capture_fields as unknown[]).filter((x): x is string => typeof x === "string")
          : undefined
      };
    }
  }
  return { to_e164: input.toE164, steps, ai_takeover: ai };
}
