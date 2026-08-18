/**
 * "This tenant's Meta credential is dead" — detected once, told once.
 *
 * A Meta page token can stop working without anyone touching New Coworker:
 * the owner changes their Facebook password, loses their Page admin role, or
 * removes the app. Every call then fails with error code 190. Until this
 * existed, nothing noticed: leads were dropped, DMs and comment replies
 * failed, Instagram publishing failed, and CAPI uploads burned all ten
 * attempts per event, while the integrations card kept saying "Connected".
 *
 * Call `reportMetaCallFailure` from any catch around a Meta call that has a
 * businessId in scope. It ignores everything that is not a 190, so it is safe
 * to sprinkle: the classifier (`isMetaTokenDead`) matches ONLY Meta's own
 * token code, never a timeout and never a 4xx in general, because acting on
 * it asks a paying customer to redo their OAuth.
 *
 * Escalation follows the calendar-poll pattern (src/lib/ai-flows/calendar-poll.ts):
 * flag the row, then alert the owner AT MOST ONCE, guarded by a marker log
 * written before the dispatch so a crash mid-send cannot produce a second
 * alert.
 */
import { isMetaTokenDead } from "@/lib/meta/client";
import { setMetaTokenInvalid } from "@/lib/db/meta-connections";
import { recordSystemLog } from "@/lib/db/system-logs";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { logger } from "@/lib/logger";

/** Marker event for the once-per-connection owner alert. */
export const META_TOKEN_ALERT_EVENT = "meta_token_owner_alerted";

/**
 * Record a Meta call failure. Returns true when this failure was a dead
 * token AND this call was the one that first noticed.
 *
 * NEVER throws and never rethrows: it runs inside catch blocks whose job is
 * to handle the original failure, and a problem reporting the problem must
 * not replace it.
 */
export async function reportMetaCallFailure(
  businessId: string,
  err: unknown,
  context: { surface: string }
): Promise<boolean> {
  if (!isMetaTokenDead(err)) return false;
  try {
    const firstNotice = await setMetaTokenInvalid(businessId, true);
    logger.warn("meta token rejected", {
      businessId,
      surface: context.surface,
      firstNotice
    });
    // Only the call that flipped the flag escalates. Everything else in the
    // same outage is the same news arriving again.
    if (firstNotice) await alertOwnerMetaTokenDead(businessId, context.surface);
    return firstNotice;
  } catch (reportErr) {
    logger.error("meta token health report failed", {
      businessId,
      error: reportErr instanceof Error ? reportErr.message : String(reportErr)
    });
    return false;
  }
}

/** Clear the flag after a call succeeds, so a reconnect heals the card. */
export async function clearMetaTokenInvalid(businessId: string): Promise<void> {
  try {
    await setMetaTokenInvalid(businessId, false);
  } catch (err) {
    logger.warn("meta token health clear failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

async function alertOwnerMetaTokenDead(businessId: string, surface: string): Promise<void> {
  // Marker FIRST, then dispatch: at-most-once beats at-least-once here,
  // because the failure mode of a duplicate is texting a customer twice that
  // their integration is broken.
  await recordSystemLog({
    businessId,
    source: "app",
    level: "warn",
    event: META_TOKEN_ALERT_EVENT,
    message: "Owner alerted: the Facebook connection's access token was rejected",
    payload: { surface }
  });
  await dispatchUrgentNotification({
    businessId,
    kind: "meta_connection_broken",
    summary: "Your Facebook connection stopped working",
    smsBody:
      "New Coworker: Facebook stopped accepting our requests, so lead forms, " +
      "Messenger and Instagram replies, and post scheduling are paused. Reconnect " +
      "on the Integrations page to resume.",
    emailSubject: "Your Facebook connection needs to be reconnected",
    emailBody:
      "Facebook stopped accepting our requests for your account, so anything that " +
      "depends on it is paused: new leads from your lead forms, automatic replies on " +
      "Messenger and Instagram, comment replies, and scheduled Instagram posts.\n\n" +
      "This usually means the Facebook password changed, the Page role was removed, " +
      "or the app was removed from the Facebook account. Nothing is lost, and " +
      "reconnecting fixes it: open the Integrations page in your dashboard and " +
      "reconnect Facebook.",
    payload: { reason: "meta_token_expired", surface }
  });
}
