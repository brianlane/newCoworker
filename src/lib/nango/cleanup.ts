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
 * Ordering contract (Bugbot on the cap PR): teardown must never run BEFORE
 * the terminal step commits — a failed business delete / wipe stamp must
 * leave the tenant fully intact, not active with dead integrations. So:
 *   - hard-delete callers SNAPSHOT the rows first
 *     (`snapshotNangoConnectionLinks`), delete the business row (cascade
 *     removes the rows), then revoke the snapshot on Nango
 *     (`revokeNangoConnectionRows`);
 *   - the wipe executor stamps `wiped` first, then calls
 *     `revokeNangoConnectionsForBusiness` (the business row survives a
 *     wipe, so the rows are still readable and are deleted here).
 *
 * Everything is best-effort and never throws: a Nango blip after the
 * terminal step leaves orphans that debug/nango-audit.ts reclaims.
 */

import { logger } from "@/lib/logger";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import { getNangoClient } from "./server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type NangoConnectionLink = {
  provider_config_key: string;
  connection_id: string;
};

/**
 * Pre-delete snapshot of the business's connection links. Never throws — a
 * read blip returns [] (the revocation is then skipped and the audit script
 * reclaims the orphans later) rather than blocking the deletion.
 */
export async function snapshotNangoConnectionLinks(
  businessId: string,
  client?: SupabaseClient
): Promise<NangoConnectionLink[]> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    return await listWorkspaceOAuthConnections(businessId, db);
  } catch (err) {
    logger.warn("nango cleanup: snapshot failed (revocation will be skipped)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return [];
  }
}

/**
 * Revokes a snapshot of connections on Nango's side. Called AFTER the
 * terminal step (business-row delete) commits. Never throws; returns the
 * number of successful revocations.
 */
export async function revokeNangoConnectionRows(
  businessId: string,
  rows: readonly NangoConnectionLink[]
): Promise<number> {
  if (rows.length === 0) return 0;
  if (!process.env.NANGO_SECRET_KEY) {
    logger.warn("nango cleanup: NANGO_SECRET_KEY missing; skipping provider-side revocation", {
      businessId,
      rows: rows.length
    });
    return 0;
  }

  let revoked = 0;
  // Cannot throw here: getNangoClient only throws without the secret, and
  // the guard above already returned in that case.
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
  logger.info("nango cleanup: connections revoked", {
    businessId,
    rows: rows.length,
    revoked
  });
  return revoked;
}

/**
 * Wipe-path teardown: reads the rows (the business row survives a wipe, so
 * nothing cascades them away), revokes each on Nango, then deletes the DB
 * rows. Call AFTER the wipe stamp commits. Never throws; returns the number
 * of Nango-side revocations that succeeded.
 */
export async function revokeNangoConnectionsForBusiness(
  businessId: string,
  client?: SupabaseClient
): Promise<number> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const rows = await listWorkspaceOAuthConnections(businessId, db);
    if (rows.length === 0) return 0;

    const revoked = await revokeNangoConnectionRows(businessId, rows);

    const { error } = await db
      .from("workspace_oauth_connections")
      .delete()
      .eq("business_id", businessId);
    if (error) {
      logger.warn("nango cleanup: row delete failed", { businessId, error: error.message });
    }
    return revoked;
  } catch (err) {
    logger.warn("nango cleanup failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return 0;
  }
}
