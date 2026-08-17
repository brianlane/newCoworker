/**
 * Bounded retry schedule for Telnyx capacity-rejected dials (pure, no IO).
 *
 * A dial refused for concurrent-channel capacity (SIP/HTTP 403 "channel
 * limit exceeded", or our own pre-dial platform gate) is transient: a channel
 * frees within seconds to minutes as ringing legs resolve. Telnyx's own
 * guidance is exponential backoff plus queueing rather than dropping the
 * call, and the worker's defer mechanism IS that queue: the step re-runs in
 * full on resume (calling window, STOP, dial cap all re-checked).
 *
 * The schedule approximates exponential backoff and stays under the
 * place_ai_call wait ceiling: 2, 5, then 12 minutes, each plus up to 90s of
 * jitter so the retriers do not re-collide on the same second (the original
 * failure mode: every deferred run resuming at 08:30:00 exactly). After the
 * third retry the step gives up and resolves the not_placed sentinel with
 * CALL_REASON.CARRIER_CAPACITY so flows see a truthful, distinguishable
 * reason instead of a generic dial failure.
 */

/** Defer delays before each retry attempt, in order. length = max retries. */
export const CAPACITY_RETRY_DELAYS_MINUTES: readonly number[] = [2, 5, 12];

/** Max additive jitter on each capacity defer, in milliseconds. */
export const CAPACITY_RETRY_JITTER_MS = 90_000;

export type CapacityRetryPlan =
  | { kind: "defer"; delayMs: number; retriesSoFar: number }
  | { kind: "give_up" };

/**
 * What to do after a capacity rejection, given how many capacity retries this
 * step occurrence has already burned. `rand` is injected for tests (and for
 * determinism anywhere else callers need it); defaults to Math.random.
 */
export function capacityRetryPlan(
  retriesSoFar: number,
  rand: () => number = Math.random
): CapacityRetryPlan {
  const attempt = Number.isFinite(retriesSoFar) && retriesSoFar > 0 ? Math.floor(retriesSoFar) : 0;
  const delayMinutes = CAPACITY_RETRY_DELAYS_MINUTES[attempt];
  if (delayMinutes === undefined) return { kind: "give_up" };
  const jitterMs = Math.floor(Math.min(Math.max(rand(), 0), 1) * CAPACITY_RETRY_JITTER_MS);
  return {
    kind: "defer",
    delayMs: delayMinutes * 60_000 + jitterMs,
    retriesSoFar: attempt
  };
}

/**
 * The scope var that persists the retry count across defers. Derived from the
 * step's own resolution marker so two place_ai_call steps in one flow count
 * independently (same convention as callOutcomeCompanionVars).
 */
export function capacityRetryCountVar(marker: string): string {
  return `${marker}_capacity_retries`;
}
