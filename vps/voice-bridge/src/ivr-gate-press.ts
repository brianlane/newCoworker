/**
 * IVR accept-digit press policy for partner live-transfer gates (HomeLight etc.).
 *
 * Telnyx `send_dtmf` returning HTTP OK is NOT proof the partner accepted. An
 * early blind fallback can land during the lead announcement, before the menu
 * is listening; the partner then keeps looping "press 1" while a latch that
 * trusted the API would refuse every later press. This module decides when a
 * first press or a re-press is allowed.
 */

export type IvrPressSource = "model" | "fallback" | "refallback";

export type IvrPressDenyReason =
  | "ended"
  | "no_dtmf"
  | "in_flight"
  | "max_presses"
  | "cooldown"
  | "fallback_already_pressed";

export type IvrPressDecision =
  | { action: "press"; repress: boolean }
  | { action: "deny"; reason: IvrPressDenyReason };

/** Minimum gap between a successful model re-press and another. */
export const IVR_REPRESS_COOLDOWN_MS = 2500;

/**
 * After the first Telnyx-OK press, blind-press once more if still pre-human.
 * Covers an early fallback the model never retries.
 */
export const IVR_REFALLBACK_MS = 9000;

/**
 * Hard cap on accept-press ATTEMPTS per call. Counting attempts, not
 * Telnyx-OK presses: with a partner endpoint rejecting every send_dtmf the
 * OK count stays zero and a success-keyed cap never binds, so the failing
 * path retried without bound. Does NOT use assistant downlink as a proxy
 * for "human heard" (the model can emit accidental audio while still on
 * IVR).
 */
export const IVR_MAX_ACCEPT_PRESSES = 5;

export function decideIvrPress(args: {
  ended: boolean;
  hasDtmf: boolean;
  inFlight: boolean;
  /** True after at least one Telnyx-OK accept press this call. */
  acceptPressed: boolean;
  /** How many Telnyx-OK accept presses have already landed. */
  acceptPressCount: number;
  /** How many accept presses have been ATTEMPTED (execute called), OK or not. */
  attemptCount: number;
  lastPressAtMs: number;
  nowMs: number;
  cooldownMs?: number;
  maxPresses?: number;
  source: IvrPressSource;
}): IvrPressDecision {
  if (args.ended) return { action: "deny", reason: "ended" };
  if (!args.hasDtmf) return { action: "deny", reason: "no_dtmf" };
  if (args.inFlight) return { action: "deny", reason: "in_flight" };

  const max = args.maxPresses ?? IVR_MAX_ACCEPT_PRESSES;
  if (args.attemptCount >= max) {
    return { action: "deny", reason: "max_presses" };
  }

  if (!args.acceptPressed) {
    return { action: "press", repress: false };
  }

  // First blind fallback already ran (or the model beat it). A second "fallback"
  // timer tick must not fire; re-presses are model-on-cue or the one refallback.
  if (args.source === "fallback") {
    return { action: "deny", reason: "fallback_already_pressed" };
  }

  // The scheduled refallback is already spaced IVR_REFALLBACK_MS after the first
  // OK press. Do not let a recent model re-press eat it via the spam cooldown.
  if (args.source !== "refallback") {
    const cooldown = args.cooldownMs ?? IVR_REPRESS_COOLDOWN_MS;
    if (args.nowMs - args.lastPressAtMs < cooldown) {
      return { action: "deny", reason: "cooldown" };
    }
  }
  return { action: "press", repress: true };
}
