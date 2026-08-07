/**
 * "Reach a teammate" primitives: the pure half of putting a live caller
 * through to a person WITHOUT taking their leg away from the AI first.
 *
 * The existing transfer does the opposite. `transfer_to_owner` issues a Telnyx
 * transfer on the CALLER's own leg, so from the moment it fires the caller
 * hears ringback instead of the assistant, it accepts one target with no
 * fallback, and it reports success as soon as Telnyx accepts the command
 * rather than when a human actually answers. A caller whose teammate misses
 * therefore sits listening to a phone ring and then that teammate's voicemail,
 * with no assistant left on the line to explain or recover.
 *
 * The shape here instead dials a SECOND leg while the caller keeps talking to
 * the assistant, and only bridges the two once someone genuinely picks up. If
 * nobody does, the assistant is still there and can say so honestly, which is
 * the behavior the tenant scripts this was built for depend on.
 *
 * This module owns only the decisions, so they are testable without a live
 * call: how the B leg is labelled, how its webhook is recognized, and which
 * target to try next. The Telnyx commands and the polling live with their
 * respective runtimes.
 */

/**
 * client_state prefix for a reach attempt's B leg. Deliberately distinct from
 * the other three prefixes in this codebase (`hl:` handoff chains, `vob:`
 * outbound origination, `wt:` warm transfer), each of which has its own parser
 * that must keep REJECTING everyone else's states: a B leg misread as an
 * outbound origination would attach an AI bridge to the teammate's phone.
 */
export const REACH_CS_PREFIX = "rt";

export type ReachClientState = {
  businessId: string;
  /** The caller's leg, which stays with the assistant while B rings. */
  aLegCallControlId: string;
  /** 0-based position in the target ladder, so a late webhook is attributable. */
  attempt: number;
};

/**
 * `rt:<businessId>:<aLegCallControlId>:<attempt>`
 *
 * The leg id sits in the middle deliberately: Telnyx call ids contain colons,
 * so only the uuid and the numeric attempt can be parsed as fixed segments,
 * and the attempt has to anchor the end for the leg id to be recoverable.
 */
export function encodeReachClientState(state: ReachClientState): string {
  return [
    REACH_CS_PREFIX,
    state.businessId,
    state.aLegCallControlId,
    String(state.attempt)
  ].join(":");
}

/**
 * Parse the client_state echoed on a reach B leg's webhook.
 *
 * Telnyx returns client_state base64-encoded, so decode when it is not already
 * the plain form (covers both real webhooks and direct unit tests). Returns
 * null for anything that is not a well-formed reach state, including the other
 * three prefixes.
 */
export function parseReachClientState(
  raw: string | null | undefined
): ReachClientState | null {
  if (!raw) return null;
  let text = raw;
  if (!text.startsWith(`${REACH_CS_PREFIX}:`)) {
    try {
      text = atob(raw);
    } catch {
      return null;
    }
  }
  // A Telnyx call_control_id CONTAINS colons (they look like `v3:abc...`), so
  // the leg id cannot be matched as a colon-free segment. Only the businessId
  // (a uuid) and the trailing attempt are colon-free, so the leg is matched
  // greedily between them and the digits anchor the end. Empty segments are
  // still rejected.
  const m = /^rt:([^:]+):(.+):(\d+)$/.exec(text);
  if (!m) return null;
  const attempt = Number(m[3]);
  if (!Number.isSafeInteger(attempt) || attempt < 0) return null;
  return { businessId: m[1]!, aLegCallControlId: m[2]!, attempt };
}

/** One person the assistant may try, in ladder order. */
export type ReachTarget = {
  toE164: string;
  /** Spoken/templated name, used in the whisper and the assistant's summary. */
  name: string;
};

/** How a single attempt ended. */
export type ReachAttemptOutcome =
  /** They picked up; the legs can be bridged. */
  | "answered"
  /** Rang out, was declined, or went to their voicemail. */
  | "no_answer"
  /** The dial never happened (bad number, Telnyx refusal). */
  | "not_dialed";

/** What the caller of the ladder should do next. */
export type ReachDecision =
  | { kind: "dial"; target: ReachTarget; attempt: number }
  | { kind: "bridge" }
  | { kind: "exhausted" };

/**
 * Decide the next move given the ladder and what has happened so far.
 *
 * Pure and total: every combination resolves, so a live call can never end up
 * in an undefined state with a person waiting on the line.
 *
 * `attemptsMade` counts dials already completed, and `lastOutcome` is how the
 * most recent one ended (absent before the first dial). An "answered" outcome
 * short-circuits to bridge regardless of how many targets remain, because
 * continuing to ring the next person after someone picked up would put two
 * teammates on one caller.
 */
export function nextReachDecision(
  targets: readonly ReachTarget[],
  attemptsMade: number,
  lastOutcome?: ReachAttemptOutcome
): ReachDecision {
  if (lastOutcome === "answered") return { kind: "bridge" };
  const usable = targets.filter((t) => t.toE164.trim().length > 0);
  if (attemptsMade < 0 || attemptsMade >= usable.length) return { kind: "exhausted" };
  return { kind: "dial", target: usable[attemptsMade]!, attempt: attemptsMade };
}

/**
 * Default seconds to ring one target before moving on.
 *
 * Short on purpose. The caller is holding a live conversation while this runs,
 * and silence past roughly twenty seconds reads as the assistant having
 * abandoned them. Two targets at this length still fits inside a natural
 * "let me see if I can get someone for you" pause.
 */
export const DEFAULT_REACH_RING_SECONDS = 20;

/** Bounds a caller may configure, so a flow cannot strand someone on hold. */
export const MIN_REACH_RING_SECONDS = 5;
export const MAX_REACH_RING_SECONDS = 45;

/** Clamp a configured ring time into the supported range. */
export function clampReachRingSeconds(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_REACH_RING_SECONDS;
  if (n < MIN_REACH_RING_SECONDS) return MIN_REACH_RING_SECONDS;
  if (n > MAX_REACH_RING_SECONDS) return MAX_REACH_RING_SECONDS;
  return n;
}


/** What a reach attempt's outcome looks like on the caller's session row. */
export type ReachOutcomeStamp = {
  attempt: number;
  status: "answered" | "no_answer";
  b_leg: string;
};

/**
 * Should this B-leg event overwrite what is already recorded?
 *
 * Losing an outcome costs a real caller. If an `answered` is dropped the bridge
 * never learns the teammate picked up, so it apologizes to somebody who
 * actually got through and leaves the teammate holding a dead line. Two ways
 * that can happen:
 *
 *   1. SAME attempt, answer then hangup. A teammate who picks up and later
 *      hangs up produces both events on one leg, and the hangup must not
 *      rewrite a real conversation into a missed call.
 *   2. An OLDER attempt reporting late. The ladder hangs up the previous leg as
 *      it moves on, so that hangup can land after the next teammate has already
 *      answered. An older attempt never overwrites a newer one.
 *
 * A NEWER attempt always wins: the ladder has moved on and its outcome is the
 * current truth.
 *
 * This function is the SPECIFICATION of the rule. Under concurrent webhooks it
 * is enforced by the `record_reach_outcome` SQL function, which evaluates the
 * same three clauses inside a single statement so two events cannot both read
 * the same prior and race. Keep the two in step.
 */
export function reachOutcomeShouldApply(
  prior: { attempt?: unknown; status?: unknown } | null | undefined,
  incoming: { attempt: number; status: "answered" | "no_answer" }
): boolean {
  if (!prior) return true;
  const priorAttempt = typeof prior.attempt === "number" ? prior.attempt : -1;
  // A late event from an attempt the ladder has already left behind. The
  // previous leg is hung up as the ladder moves on, so its hangup can easily
  // land AFTER the next teammate has answered.
  if (priorAttempt > incoming.attempt) return false;
  if (priorAttempt < incoming.attempt) return true;
  return !(prior.status === "answered" && incoming.status === "no_answer");
}
