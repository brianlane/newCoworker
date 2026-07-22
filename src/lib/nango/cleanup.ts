/**
 * Best-effort teardown of a business's Nango workspace connections, for the
 * terminal paths: self-serve account deletion, admin delete-client /
 * delete-user, and the grace-expired wipe.
 *
 * Why: deleting a business row cascades the `workspace_oauth_connections`
 * rows away, but Nango's side of each connection lives on — and every
 * leaked connection consumes the platform's ACCOUNT-WIDE Nango quota
 * forever. The wipe path is worse: it keeps the business row, so without
 * this nothing ever revokes the tenant's grants at all.
 *
 * Never throws: a deletion/wipe must not fail over a third-party API blip
 * (leaked connections are operator-recoverable via debug/nango-audit.ts).
 */

import { logger } from "@/lib/logger";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import { getNangoClient } from "./server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Revokes every Nango connection of the business (provider side), then
 * deletes the DB rows — redundant when the caller hard-deletes the business
 * row (cascade), required on the wipe path (business row survives).
 * Returns the number of Nango-side revocations that succeeded.
 */
export async function revokeNangoConnectionsForBusiness(
  businessId: string,
  client?: SupabaseClient
): Promise<number> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const rows = await listWorkspaceOAuthConnections(businessId, db);
    if (rows.length === 0) return 0;

    let revoked = 0;
    if (process.env.NANGO_SECRET_KEY) {
      const nango = getNangoClient();
      for (const row of rows) {
        try {
          await nango.deleteConnection(row.provider_config_key, row.connection_id);
          revoked += 1;
        } catch (err) {
          logger.warn("nango cleanup: deleteConnection failed (leaks account quota)", {
            businessId,
            providerConfigKey: row.provider_config_key,
            connectionId: row.connection_id,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    } else {
      logger.warn("nango cleanup: NANGO_SECRET_KEY missing; skipping provider-side revocation", {
        businessId,
        rows: rows.length
      });
    }

    const { error } = await db
      .from("workspace_oauth_connections")
      .delete()
      .eq("business_id", businessId);
    if (error) {
      logger.warn("nango cleanup: row delete failed", { businessId, error: error.message });
    }

    logger.info("nango cleanup: connections torn down", {
      businessId,
      rows: rows.length,
      revoked
    });
    return revoked;
  } catch (err) {
    logger.warn("nango cleanup failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return 0;
  }
}
