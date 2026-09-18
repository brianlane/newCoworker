/**
 * "This tenant's Meta credential is dead": detected once, then the shared
 * needs_reauth loop emails (once on the flip, once more after a day, then
 * stop). Call `reportMetaCallFailure` from any catch around a Meta call
 * that has a businessId in scope. It ignores everything that is not a 190.
 */
import { isMetaTokenDead } from "@/lib/meta/client";
import { getMetaConnection, setMetaTokenInvalid } from "@/lib/db/meta-connections";
import { markConnectionNeedsReauth } from "@/lib/connections/reauth";
import { logger } from "@/lib/logger";

/**
 * Record a Meta call failure. Returns true when this failure was a dead
 * token AND this call was the one that first flipped needs_reauth.
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
    await setMetaTokenInvalid(businessId, true);
    const conn = await getMetaConnection(businessId);
    if (!conn) return false;
    const marked = await markConnectionNeedsReauth("meta_connections", conn.id);
    logger.warn("meta token rejected", {
      businessId,
      surface: context.surface,
      flipped: marked.flipped
    });
    return marked.flipped;
  } catch (reportErr) {
    logger.error("meta token health report failed", {
      businessId,
      error: reportErr instanceof Error ? reportErr.message : String(reportErr)
    });
    return false;
  }
}

/** Clear the since-when stamp after a call succeeds. Reconnect clears needs_reauth. */
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
