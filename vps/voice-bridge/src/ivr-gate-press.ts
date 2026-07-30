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
  | "human_heard"
  | "cooldown"
  | "fallback_already_pressed";

export type IvrPressDecision =
  | { action: "press"; repress: boolean }
  | { action: "deny"; reason: IvrPressDenyReason };

/** Minimum gap between a successful press and another while still pre-human. */
export const IVR_REPRESS_COOLDOWN_MS = 2500;

/**
 * After the first Telnyx-OK press, blind-press once more if no human has been
 * heard yet. Covers an early fallback the model never retries.
 */
export const IVR_REFALLBACK_MS = 9000;

export function decideIvrPress(args: {
  ended: boolean;
  hasDtmf: boolean;
  inFlight: boolean;
  /** True after at least one Telnyx-OK accept press this call. */
  acceptPressed: boolean;
  /** True once the assistant has spoken (opener after a real person connected). */
  humanHeard: boolean;
  lastPressAtMs: number;
  nowMs: number;
  cooldownMs?: number;
  source: IvrPressSource;
}): IvrPressDecision {
  if (args.ended) return { action: "deny", reason: "ended" };
  if (!args.hasDtmf) return { action: "deny", reason: "no_dtmf" };
  if (args.humanHeard) return { action: "deny", reason: "human_heard" };
  if (args.inFlight) return { action: "deny", reason: "in_flight" };

  if (!args.acceptPressed) {
    return { action: "press", repress: false };
  }

  // First blind fallback already ran (or the model beat it). A second "fallback"
  // timer tick must not fire; re-presses are model-on-cue or the one refallback.
  if (args.source === "fallback") {
    return { action: "deny", reason: "fallback_already_pressed" };
  }

  const cooldown = args.cooldownMs ?? IVR_REPRESS_COOLDOWN_MS;
  if (args.nowMs - args.lastPressAtMs < cooldown) {
    return { action: "deny", reason: "cooldown" };
  }
  return { action: "press", repress: true };
}
