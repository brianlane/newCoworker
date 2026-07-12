/**
 * DELETE /api/admin/delete-user
 *
 * Complete account removal for test/junk accounts — the BizBlasts users-admin
 * delete, adapted to newCoworker's shape. For the given email it:
 *   1. refuses when ANY owned business has a Stripe-linked, non-canceled
 *      subscription (cancel billing first via Force-cancel & wipe — this
 *      route must never orphan live Stripe billing);
 *   2. stops any Hostinger VMs still attached to owned businesses
 *      (best-effort; a 404 means the box is already gone);
 *   3. hard-deletes every owned business row (FK cascades take the tenant's
 *      content, members, logs, and subscription history with it);
 *   4. removes the email's membership grants on OTHER tenants;
 *   5. deletes the Supabase auth user LAST — everything above is keyed on
 *      the email (not the auth id), so a failure at any step leaves the
 *      login intact and the whole DELETE retryable; a failure on the final
 *      auth step is also retryable (the re-run finds no rows and just
 *      removes the auth user); and
 *   6. writes an admin audit entry (payload-only business ids — the FK
 *      targets are gone).
 *
 * Deliberately NOT a lifecycle flow: no backups, no grace window, no owner
 * emails. This is the "it was a test account, make it disappear" path.
 */

import { z } from "zod";
import { requireAdmin, findAuthUserIdByEmail } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { deleteBusiness, listBusinesses } from "@/lib/db/businesses";
import { listBusinessIdsWithStripeLinkedSubscription } from "@/lib/db/subscriptions";
import { deleteBusinessMembersByEmail } from "@/lib/db/business-members";
import { logAdminAction } from "@/lib/admin/audit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  HostingerClient,
  HostingerApiError,
  DEFAULT_HOSTINGER_BASE_URL
} from "@/lib/hostinger/client";
import { logger } from "@/lib/logger";

const schema = z.object({
  email: z.string().email()
});

export async function DELETE(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = schema.parse(await request.json());
    const email = body.email.trim().toLowerCase();

    // Never let the admin nuke their own login.
    if (admin.email && admin.email.toLowerCase() === email) {
      return errorResponse("VALIDATION_ERROR", "Refusing to delete the admin account", 400);
    }

    // Case-INSENSITIVE ownership match (mirrors the user detail page):
    // `businesses.owner_email` keeps signup casing, so an equality lookup on
    // the lowercased email could miss owned tenants — deleting the auth user
    // while their businesses (and the Stripe/VM guards) silently survive.
    const ownedBusinesses = (await listBusinesses()).filter(
      (b) => (b.owner_email ?? "").trim().toLowerCase() === email
    );
    const businessIds = ownedBusinesses.map((b) => b.id);

    // Billing guard: fail closed if Stripe is (or may start) billing any
    // owned business. Force-cancel & wipe is the path for paying tenants.
    const stripeLinked = await listBusinessIdsWithStripeLinkedSubscription(businessIds);
    if (stripeLinked.size > 0) {
      return errorResponse(
        "CONFLICT",
        "A business owned by this user has live Stripe billing — force-cancel it first",
        409
      );
    }

    // Stop any VMs still attached so deleting the business rows can't strand
    // a running (billed) box with no DB correlation left to find it by.
    for (const business of ownedBusinesses) {
      const businessId = business.id;
      if (!business.hostinger_vps_id) continue;
      const vmId = Number.parseInt(business.hostinger_vps_id, 10);
      if (!Number.isFinite(vmId)) {
        logger.warn("admin.delete-user: non-numeric hostinger_vps_id; cannot stop VM", {
          adminEmail: admin.email,
          businessId,
          hostingerVpsId: business.hostinger_vps_id
        });
        continue;
      }
      try {
        const hostinger = new HostingerClient({
          baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
          token: process.env.HOSTINGER_API_TOKEN ?? ""
        });
        await hostinger.stopVirtualMachine(vmId);
      } catch (err) {
        if (err instanceof HostingerApiError && err.status === 404) {
          logger.info("admin.delete-user: VM already gone (404)", {
            businessId,
            virtualMachineId: vmId
          });
        } else {
          logger.error("admin.delete-user: failed to stop VM (continuing)", {
            adminEmail: admin.email,
            businessId,
            virtualMachineId: vmId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    // Rows first, auth user LAST. Unlike delete-client (whose only handle on
    // the auth user is the soon-to-be-deleted business row), everything here
    // keys on the email — so if a business delete throws partway, the login
    // still exists and re-running this same DELETE finishes the job. The
    // opposite order would strand a half-deleted account behind a dead login.
    for (const businessId of businessIds) {
      await deleteBusiness(businessId);
    }
    const membershipsRemoved = await deleteBusinessMembersByEmail(email);

    // "Not found" is the desired end state; any other auth failure is
    // surfaced for a retry (which will find zero rows and only do this step).
    const authUserId = await findAuthUserIdByEmail(email);
    if (authUserId) {
      const db = await createSupabaseServiceClient();
      const { error } = await db.auth.admin.deleteUser(authUserId);
      if (error && !/not found|does not exist/i.test(error.message ?? "")) {
        logger.error("admin.delete-user: auth user delete failed", {
          adminEmail: admin.email,
          email,
          supabaseUserId: authUserId,
          error: error.message
        });
        return errorResponse(
          "INTERNAL_SERVER_ERROR",
          "Business data removed but the login could not be deleted — retry to finish",
          500
        );
      }
    }

    await logAdminAction({
      adminEmail: admin.email,
      action: "delete_user",
      detail: {
        email,
        deletedBusinessIds: businessIds,
        membershipsRemoved,
        authUserDeleted: Boolean(authUserId)
      }
    });

    return successResponse({
      deleted: true,
      businessesDeleted: businessIds.length,
      membershipsRemoved
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
