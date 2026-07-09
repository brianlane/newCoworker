/**
 * Adopt-time cascade delete of stale tenants (admin release-to-pool flow).
 *
 * An admin can return a live account's VPS to the `vps_inventory` pool
 * (POST /api/admin/vps/[businessId]/release-to-pool) without touching the
 * account itself — the old tenant keeps running on the box until a new
 * signup claims it. The moment the adopt path recreates the box for the new
 * tenant, the old account's data on it is gone and its `businesses` row is a
 * live hazard: it still points `hostinger_vps_id` at hardware someone else
 * now owns, so any owner/admin action on the old account (redeploy, SSH,
 * hardware migration) would clobber the new tenant.
 *
 * This module severs that linkage right after a successful adopt: every
 * OTHER business still pointing at the adopted VM is cascade-deleted —
 * the `businesses` row delete fans out through the schema's
 * `ON DELETE CASCADE` foreign keys (configs, contacts, logs, telnyx
 * settings, tokens, SSH keys, …), and the owner's Supabase auth user is
 * deleted best-effort so the login dies with the account — but ONLY when
 * that email owns no other business rows (one login can own several
 * businesses in the multi-business agency model, and could even be the
 * adopting signup itself).
 *
 * Deliberately NOT deleted: businesses in status `wiped`. Those rows are
 * the lifecycle engine's audit stamps (cancel → grace → wipe) and carry no
 * live control surface; deleting them would destroy the audit trail the
 * wipe flow intentionally preserves.
 *
 * Every step is best-effort per business: one failure is logged and the
 * loop continues, and the CALLER (the orchestrator's adopt path) treats a
 * thrown error as non-fatal — a cleanup failure must never abort a signup
 * that already has its box.
 */

import { logger } from "@/lib/logger";
import {
  deleteBusiness,
  listBusinessesByHostingerVpsId,
  listBusinessIdsByOwnerEmail,
  type BusinessRow
} from "@/lib/db/businesses";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type StaleTenantCleanupDeps = {
  listByVpsId?: typeof listBusinessesByHostingerVpsId;
  deleteBiz?: typeof deleteBusiness;
  /** Every business id an owner email still owns (multi-business agencies). */
  listBusinessIdsForEmail?: typeof listBusinessIdsByOwnerEmail;
  /** Resolve an owner email to a Supabase auth user id (null = none). */
  findAuthUserId?: (email: string) => Promise<string | null>;
  /** Delete a Supabase auth user by id. */
  deleteAuthUser?: (userId: string) => Promise<void>;
};

export type StaleTenantCleanupResult = {
  deletedBusinessIds: string[];
};

/* c8 ignore start -- production defaults; tests inject deps. Lazy import of
   @/lib/auth keeps its next/headers dependency out of module graphs that
   only need the pure cleanup logic. */
async function defaultFindAuthUserId(email: string): Promise<string | null> {
  const { findAuthUserIdByEmail } = await import("@/lib/auth");
  return findAuthUserIdByEmail(email);
}

async function defaultDeleteAuthUser(userId: string): Promise<void> {
  const db = await createSupabaseServiceClient();
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) throw new Error(error.message ?? String(error));
}
/* c8 ignore stop */

function isStale(business: BusinessRow, newBusinessId: string): boolean {
  return business.id !== newBusinessId && business.status !== "wiped";
}

/**
 * Delete every non-wiped business (other than `newBusinessId`) that still
 * references `vmId`. Returns the ids that were actually deleted.
 */
export async function cleanupStaleTenantsForVm(
  args: { vmId: number | string; newBusinessId: string },
  deps: StaleTenantCleanupDeps = {}
): Promise<StaleTenantCleanupResult> {
  /* c8 ignore start -- trivial production-default fallbacks; tests inject all deps */
  const listByVpsId = deps.listByVpsId ?? listBusinessesByHostingerVpsId;
  const deleteBiz = deps.deleteBiz ?? deleteBusiness;
  const listBusinessIdsForEmail = deps.listBusinessIdsForEmail ?? listBusinessIdsByOwnerEmail;
  const findAuthUserId = deps.findAuthUserId ?? defaultFindAuthUserId;
  const deleteAuthUser = deps.deleteAuthUser ?? defaultDeleteAuthUser;
  /* c8 ignore stop */

  const vpsId = String(args.vmId);
  const linked = await listByVpsId(vpsId);
  const stale = linked.filter((business) => isStale(business, args.newBusinessId));

  const deletedBusinessIds: string[] = [];
  for (const business of stale) {
    // Business row first: severing the control surface over the adopted box
    // is the safety-critical half. Only after the row is gone do we consider
    // the login — and only when the email owns NOTHING else.
    try {
      await deleteBiz(business.id);
      deletedBusinessIds.push(business.id);
      logger.warn("stale-tenant cleanup: cascade-deleted business after its VPS was adopted", {
        staleBusinessId: business.id,
        staleBusinessName: business.name,
        vpsId,
        adoptedByBusinessId: args.newBusinessId
      });
    } catch (err) {
      // Loud but non-fatal: the adopt already succeeded. The stale row still
      // pointing at the box is dangerous (see module header), so this error
      // is the operator's cue to delete it manually. Skip the auth-user step
      // entirely — the login must survive while its business row does.
      logger.error("stale-tenant cleanup: business delete FAILED — stale row still references the adopted box", {
        staleBusinessId: business.id,
        vpsId,
        adoptedByBusinessId: args.newBusinessId,
        error: err instanceof Error ? err.message : String(err)
      });
      continue;
    }
    // Auth-user hygiene, best-effort: one login can own several businesses
    // (multi-business agencies — including, in theory, the adopting signup
    // itself), so the user is only deleted when the email owns zero
    // remaining rows AFTER this row's delete.
    if (business.owner_email) {
      try {
        const remaining = await listBusinessIdsForEmail(business.owner_email);
        if (remaining.length === 0) {
          const authUserId = await findAuthUserId(business.owner_email);
          if (authUserId) {
            await deleteAuthUser(authUserId);
          }
        } else {
          logger.info("stale-tenant cleanup: owner email still owns other businesses; keeping auth user", {
            staleBusinessId: business.id,
            ownerEmail: business.owner_email,
            remainingBusinessCount: remaining.length
          });
        }
      } catch (err) {
        logger.error("stale-tenant cleanup: auth user cleanup failed (business row already deleted)", {
          staleBusinessId: business.id,
          ownerEmail: business.owner_email,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }
  return { deletedBusinessIds };
}
