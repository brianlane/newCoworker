/**
 * What both Meta app callbacks actually DO.
 *
 * The Deauthorize callback (they removed our app) and the Data Deletion
 * Request callback (they asked us to delete what Facebook gave us) differ
 * only in what Meta expects back: deletion needs a confirmation code and a
 * status URL, deauthorization needs nothing. The action is the same, so it
 * lives here once.
 *
 * SCOPE, deliberately narrow: we destroy the Meta-derived data on the
 * connection, meaning both tokens, the account name, and the Page and
 * Instagram identifiers. We do NOT touch the tenant's contacts, leads, or
 * conversations. Those are the business's own records about its own
 * customers, held on a different basis, and erasing a company's CRM because
 * an administrator removed a Facebook app would be both wrong and
 * unrecoverable. Meta's requirement is to delete "any data your app has from
 * Facebook about the user", and the user here is the person who authorized
 * the app, not the tenant's customers.
 */
import {
  clearMetaConnectionData,
  listMetaConnectionsByMetaUserId
} from "@/lib/db/meta-connections";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";

export type MetaDeauthorizeResult = {
  /** How many connections were actually cleared. */
  cleared: number;
  /** Businesses affected, for the audit line. */
  businessIds: string[];
  /**
   * True when the app-scoped id matched nothing we hold. A legitimate
   * outcome, NOT an error: the person may have authorized before we started
   * recording the id, or never finished connecting.
   */
  unmatched: boolean;
};

/**
 * Sever every connection the given Facebook user authorized.
 *
 * Never throws for a per-connection failure: Meta retries neither callback,
 * and a partial sever plus a loud log beats an exception that leaves every
 * connection intact.
 */
export async function deauthorizeMetaUser(
  metaUserId: string,
  reason: "deauthorize" | "data_deletion"
): Promise<MetaDeauthorizeResult> {
  const connections = await listMetaConnectionsByMetaUserId(metaUserId);
  if (connections.length === 0) {
    logger.warn("meta callback matched no connection", { reason });
    return { cleared: 0, businessIds: [], unmatched: true };
  }

  const businessIds: string[] = [];
  let cleared = 0;
  for (const connection of connections) {
    try {
      if (await clearMetaConnectionData(connection.id)) {
        cleared += 1;
        businessIds.push(connection.business_id);
      }
    } catch (err) {
      logger.error("meta callback failed to clear a connection", {
        reason,
        connectionId: connection.id,
        businessId: connection.business_id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // One audit line per affected tenant, so the owner's support history shows
  // why their integration stopped. recordSystemLog swallows its own persist
  // failures, so there is nothing to catch here.
  for (const businessId of businessIds) {
    await recordSystemLog({
      businessId,
      source: "app",
      level: "warn",
      event: reason === "deauthorize" ? "meta_app_deauthorized" : "meta_data_deletion_requested",
      message:
        reason === "deauthorize"
          ? "Facebook reported this app was removed, so the Meta connection was cleared. Reconnect under Integrations to resume leads, messages, and comment replies."
          : "A Facebook data deletion request cleared this Meta connection. Reconnect under Integrations to resume leads, messages, and comment replies.",
      payload: { cleared }
    });
  }

  return { cleared, businessIds, unmatched: false };
}
