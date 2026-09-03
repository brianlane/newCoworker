/**
 * Keep-for-owner (owner-direct) alert copy and the post-park "1" absorb.
 *
 * The $1M+ path parks on the owner's forward number and nudges at 10 and
 * 30 minutes until they reply "1". That "1" is an acknowledgement, never a
 * claim. After the park finishes, a stray "1" used to fall through the
 * late-claim matcher (finalize() had deleted step_index) and land on an
 * unrelated lapsed offer (Jason Ellis, Amy Laidlaw, 2026-09-02).
 *
 * Pure, so vitest pins the wording the way it pins offer_reminders.ts.
 */

/** How long after a finished owner-direct park a bare "1" is still an ack. */
export const OWNER_DIRECT_ACK_WINDOW_MS = 60 * 60 * 1000;

/**
 * ALL-CAPS owner reminder for an unacknowledged keep-for-owner alert. The
 * framing lines are uppercase (per Amy's ask); the alert body keeps its
 * original casing because it carries case-sensitive short links
 * (rltr.pro/XKVuC) and names that uppercasing would corrupt.
 *
 * The FINAL reminder does not invite a "1": nothing is left to stop, and
 * that invite is what sent Amy's second "1" onto Jason Ellis.
 */
export function ownerDirectNudgeText(alertBody: string, minutes: number, final: boolean): string {
  const head = final
    ? `FINAL REMINDER (${minutes} MINUTES): HIGH-VALUE LEAD IS STILL WAITING FOR YOU.`
    : `REMINDER (${minutes} MINUTES): HIGH-VALUE LEAD IS STILL WAITING FOR YOU.`;
  const tail = final
    ? "THIS WAS THE LAST REMINDER. NO REPLY NEEDED."
    : `REPLY "1" TO STOP THESE REMINDERS.`;
  return `${head}\n${alertBody}\n${tail}`;
}

/**
 * The reply when the owner texts "1" shortly after the park already ended.
 * Names the lead so they can see which alert this was about, and asks
 * nothing of them.
 */
export function ownerDirectAlreadyStoppedText(leadLabel: string): string {
  const lead = leadLabel.trim() || "this lead";
  return `Got it, the reminders for ${lead} already stopped. Nothing else needed.`;
}
