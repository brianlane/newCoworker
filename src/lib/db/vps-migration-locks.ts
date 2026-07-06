/**
 * In-flight lease for elective hardware migrations (admin migrate-size).
 *
 * Backed by `vps_migration_locks` + the `try_claim_vps_migration` /
 * `release_vps_migration_lock` RPCs (migration 20260731000100). The route
 * claims before dispatching the background migration and refuses with 409
 * when a lease is already held; the background job releases the lease in
 * its terminal path. Leases self-expire (default 30 min — double the
 * route's 300s `maxDuration` budget with slack) so a crashed job can never
 * wedge a business permanently.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Returns true when this caller now owns the migration lease. */
export async function tryClaimVpsMigration(
  businessId: string,
  requestedBy: string,
  targetSize: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("try_claim_vps_migration", {
    p_business_id: businessId,
    p_requested_by: requestedBy,
    p_target_size: targetSize
  });
  if (error) throw new Error(`tryClaimVpsMigration: ${error.message}`);
  return data === true;
}

/**
 * Release the lease. Best-effort by design — a failed release only means
 * the next migration for this business waits out the lease expiry.
 */
export async function releaseVpsMigrationLock(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.rpc("release_vps_migration_lock", {
    p_business_id: businessId
  });
  if (error) throw new Error(`releaseVpsMigrationLock: ${error.message}`);
}
