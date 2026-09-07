/**
 * One transfer (or reach ladder) per live call.
 *
 * `transfer_to_owner` is dispatched with `void (async () => execute())()`, so
 * the model can fire the tool again while the first ladder is still ringing.
 * Concurrent ladders share `voice_handoff_sessions.context.reach`, keyed only
 * by attempt number: a later ladder reads an earlier one's `no_answer` stamp
 * and hangs up a teammate's ringing phone within a second (Amy Laidlaw,
 * 2026-09-06, eight tool calls on one seller call).
 *
 * This module is the decision only. Gate state lives in the attachGemini
 * closure (one call = one session). `inFlight` MUST be set synchronously in
 * the tool-call loop, before the async IIFE, or two calls in one Live
 * `toolCall` batch both start ladders.
 */

export type TransferGateDenyReason = "in_flight" | "cooldown" | "max_attempts";

export type TransferGateDecision =
  | { action: "start" }
  | { action: "deny"; reason: TransferGateDenyReason; detail: string };

/** After a ladder returns nobody-answered, refuse another start this long. */
export const TRANSFER_RETRY_COOLDOWN_MS = 60_000;

/** Hard cap on transfer/ladder starts per call, cooldown or not. */
export const TRANSFER_MAX_ATTEMPTS_PER_CALL = 2;

export const TRANSFER_REFUSED_DETAIL: Record<TransferGateDenyReason, string> = {
  in_flight:
    "already ringing the team; stay with the caller, you will get exactly one result",
  cooldown:
    "the team was just rung and nobody answered; do not call this tool again on this call. Close out honestly: the team was texted the heads-up and someone will call back",
  max_attempts:
    "the team was already rung twice on this call; do not call this tool again. Close out honestly: the team was texted the heads-up and someone will call back"
};

/**
 * Should this `transfer_to_owner` start a new ladder (or single-target
 * transfer), or be refused so the in-flight one is the only one that runs?
 */
export function decideTransferStart(args: {
  inFlight: boolean;
  /** How many ladders/transfers have already been STARTED on this call. */
  attemptCount: number;
  /** Wall clock of the most recent !ok return, or null if none yet. */
  lastExhaustedAtMs: number | null;
  nowMs: number;
  cooldownMs?: number;
  maxAttempts?: number;
}): TransferGateDecision {
  if (args.inFlight) {
    return {
      action: "deny",
      reason: "in_flight",
      detail: TRANSFER_REFUSED_DETAIL.in_flight
    };
  }
  const max = args.maxAttempts ?? TRANSFER_MAX_ATTEMPTS_PER_CALL;
  if (args.attemptCount >= max) {
    return {
      action: "deny",
      reason: "max_attempts",
      detail: TRANSFER_REFUSED_DETAIL.max_attempts
    };
  }
  if (args.lastExhaustedAtMs != null) {
    const cooldown = args.cooldownMs ?? TRANSFER_RETRY_COOLDOWN_MS;
    if (args.nowMs - args.lastExhaustedAtMs < cooldown) {
      return {
        action: "deny",
        reason: "cooldown",
        detail: TRANSFER_REFUSED_DETAIL.cooldown
      };
    }
  }
  return { action: "start" };
}
