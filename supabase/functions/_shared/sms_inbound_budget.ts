/**
 * Wall-clock budget for the inbound SMS dispatch loop.
 *
 * sms-inbound-worker claims up to 8 jobs per run and works them sequentially.
 * Every per-job timeout in that worker was sized against the pg_cron cap as if
 * ONE job ran per invocation: ROWBOAT_RETRY_BUDGET_MS = 80_000 is documented as
 * "the 90s cron cap minus a 10s reserve", and OWNER_SMS_TURN_TIMEOUT_MS =
 * 75_000 has "the same worst-case budget shape". Nothing bounded the batch, so
 * eight slow jobs could run ~12 minutes.
 *
 * Two things cut that short, and neither is graceful:
 *
 *   1. Supabase 504s an Edge function that has not responded within 150s.
 *      The worker is killed mid-batch.
 *   2. pg_cron hangs up at its own timeout and records the run as a timeout.
 *
 * A killed worker leaves its remaining claims sitting at 'processing'. Those
 * rows block their contact's queue (claim_sms_inbound_jobs will not claim a
 * newer job for a contact that already has one in flight) until the
 * stale-claim recovery sweep resets them, and every recovery burns one of the
 * job's MAX_ATTEMPTS = 8 retries. So the failure mode is a customer waiting on
 * a reply that is quietly consuming its own retry budget.
 *
 * The fix is to stop starting new jobs before the ceiling, and hand the
 * untouched ones straight back to 'pending' so the next tick (every 30s) picks
 * them up with their retry count intact.
 */

/**
 * Reserve after the model call for the Telnyx send, the DB writes and the
 * telemetry that follow it.
 */
export const SMS_INBOUND_JOB_TAIL_RESERVE_MS = 10_000;

/**
 * Floor for the model call. Below this the call cannot plausibly return
 * anything, but it is still cheaper to attempt it than to add a new skip
 * branch to the reply path.
 */
export const SMS_INBOUND_MIN_MODEL_BUDGET_MS = 5_000;

/**
 * Worst case for a single job.
 *
 * The owner-operator path is NOT bounded by OWNER_SMS_TURN_TIMEOUT_MS alone,
 * which is what an earlier version of this file assumed. An owner turn can
 * burn its full 75_000 and return null, and the caller then falls through to
 * the Rowboat staff path so the owner is never silenced by a platform hiccup.
 * With a fresh ROWBOAT_RETRY_BUDGET_MS (80_000) that is 75 + 80 + 10 = 165s
 * for ONE job, over the 150s ceiling on its own and long before any batching.
 *
 * smsInboundModelBudgetMs closes that by handing the Rowboat call whatever is
 * left of this budget rather than a fresh window, so the composition is
 * 75_000 (owner turn) + 5_000 (model floor) + 10_000 (tail) = 90_000, and the
 * remaining headroom absorbs the DB reads between those steps.
 */
export const SMS_INBOUND_WORST_CASE_JOB_MS = 100_000;

/**
 * How long the model call may run, given how much of the job is already gone.
 *
 * `requestedMs` is what the caller would use if the job were fresh
 * (ROWBOAT_RETRY_BUDGET_MS). This only ever LOWERS it, so a plain customer
 * job, which reaches the model call within a few hundred ms, is unaffected and
 * keeps the full 80s it has today. It bites only after an owner turn has
 * already spent most of the job.
 */
export function smsInboundModelBudgetMs(elapsedInJobMs: number, requestedMs: number): number {
  const remaining =
    SMS_INBOUND_WORST_CASE_JOB_MS - SMS_INBOUND_JOB_TAIL_RESERVE_MS - elapsedInJobMs;
  // The floor lifts the remaining-time clamp, it does not override the caller:
  // asking for less than the floor still gets what was asked for.
  return Math.min(requestedMs, Math.max(SMS_INBOUND_MIN_MODEL_BUDGET_MS, remaining));
}

/**
 * Stop starting new jobs once this much of the run is gone.
 *
 * Sized so the worst case still lands inside the 150s Edge request ceiling:
 * a job started at 39.9s can run to SMS_INBOUND_WORST_CASE_JOB_MS, giving
 * 40_000 + 100_000 = 140_000, which leaves a 10s reserve against the ceiling.
 * The same shape as CALL_SUMMARY_TIME_BUDGET_MS in call_summary_sweep.ts.
 *
 * The cron job's timeout_milliseconds must cover that 140s worst case, which
 * is why 20260822070248_sms_inbound_release_deferred_claims.sql raises it from
 * 90000 to 150000. See the README section "The cron chain has three timeouts,
 * and a hard ceiling under all of them".
 */
export const SMS_INBOUND_BATCH_BUDGET_MS = 40_000;

/**
 * Whether there is room to START another job. Checked before each job rather
 * than after, because what matters is whether the NEXT one can finish.
 *
 * `startedIndex` is the position of the job about to run. Index 0 always gets
 * to run: a batch that returns without touching a single job would spin,
 * re-claiming and re-releasing the same rows every 30s and never draining the
 * queue. Guaranteeing one job per run guarantees forward progress even if the
 * claim itself was slow.
 *
 * `elapsedMs` must be measured from the START OF THE INVOCATION, not from the
 * top of the dispatch loop. The 150s ceiling starts when Supabase begins the
 * request, so the bearer check and claim_sms_inbound_jobs spend the same
 * budget the jobs do. Timing from the loop instead would let a 20s claim plus
 * a 49s first job green-light a second job that runs to 140s and overruns.
 */
export function smsInboundBatchHasRoom(
  startedIndex: number,
  elapsedMs: number,
  budgetMs: number = SMS_INBOUND_BATCH_BUDGET_MS
): boolean {
  if (startedIndex === 0) return true;
  return elapsedMs < budgetMs;
}

/**
 * The ids of jobs the run claimed but never started, given the index it
 * stopped at. These go back to 'pending' with their attempt_count restored.
 */
export function smsInboundDeferredIds<T extends { id: string }>(
  claimed: readonly T[],
  stoppedAtIndex: number
): string[] {
  if (stoppedAtIndex >= claimed.length) return [];
  return claimed.slice(Math.max(0, stoppedAtIndex)).map((job) => job.id);
}
