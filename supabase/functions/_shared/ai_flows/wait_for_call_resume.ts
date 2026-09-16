/**
 * How a `wait_for_call` step resolves when it comes back from the park.
 *
 * The park is shared with `place_ai_call`, so the timeout sweep
 * (`resume_overdue_call_waits`) writes the outbound sentinel `no_answer`.
 * This step only ever promises `answered` / `no_call`. That mapping used to
 * treat every sweep as `no_call`, even when the linked inbound session had
 * already finished (HomeLight Referral run 61550503, 2026-09-15: AI spoke
 * for ~10 minutes, hangup did not resume the wait, sweep fired, flow recorded
 * `no_call` with the captured seller details sitting on the session).
 *
 * A session row for this wait means the partner DID place the call. Timeout
 * then is "the webhook never woke us", not "no call came in".
 */

export function waitCallOutcomeFromResume(opts: {
  resumedOutcome: string;
  sessionStatus?: string | null;
}): { outcome: string; timedOut: boolean } {
  const sweepTimedOut = opts.resumedOutcome === "no_answer";
  const sessionHappened =
    typeof opts.sessionStatus === "string" && opts.sessionStatus.trim().length > 0;
  if (sweepTimedOut && sessionHappened) {
    return { outcome: "answered", timedOut: true };
  }
  const outcome = !opts.resumedOutcome || sweepTimedOut ? "no_call" : opts.resumedOutcome;
  return { outcome, timedOut: sweepTimedOut };
}
