/**
 * POST /api/admin/vps/:businessId/release-to-pool
 *
 * Admin-only: mark a tenant's Hostinger box `available` in the
 * `vps_inventory` adopt pool WITHOUT tearing the tenant down. The account
 * keeps running on the box until a new signup's adopt-first claim picks it
 * up; at that moment the adopt path recreates the box and cascade-deletes
 * the old account (business row + all ON DELETE CASCADE tenant data + the
 * owner's auth user) via `cleanupStaleTenantsForVm`.
 *
 * Fail-closed guards:
 *   - Hostinger-lifecycle tenants only (BYOS/OVH boxes are not pool stock).
 *   - Refuses while the tenant's subscription is `active`/`past_due`: the
 *     eventual cascade delete would silently keep charging the owner. Force
 *     cancel first (delete-client) if the intent is "nuke now".
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import { getSubscription } from "@/lib/db/subscriptions";
import { releaseVpsToPool } from "@/lib/db/vps-inventory";
import { resolveDeployedVpsSize } from "@/lib/vps/size";
import { providerUsesHostingerLifecycle, resolveVpsProvider } from "@/lib/vps/provider";
import { logger } from "@/lib/logger";

const paramsSchema = z.object({ businessId: z.string().uuid() });

export async function POST(
  _request: Request,
  ctx: { params: Promise<{ businessId: string }> }
) {
  try {
    const admin = await requireAdmin();
    const { businessId } = paramsSchema.parse(await ctx.params);

    const business = await getBusiness(businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);

    const provider = resolveVpsProvider(business.vps_provider);
    if (!providerUsesHostingerLifecycle(provider)) {
      return errorResponse(
        "VALIDATION_ERROR",
        `Only Hostinger-lifecycle boxes can join the adopt pool (provider: ${provider})`
      );
    }

    const vmId = Number.parseInt(business.hostinger_vps_id ?? "", 10);
    if (!Number.isFinite(vmId) || vmId <= 0) {
      return errorResponse("VALIDATION_ERROR", "Business has no Hostinger VPS to release");
    }

    const subscription = await getSubscription(businessId);
    if (subscription && (subscription.status === "active" || subscription.status === "past_due")) {
      return errorResponse(
        "CONFLICT",
        "Subscription is still billing. Cancel it first (or use Force-cancel & wipe) — " +
          "releasing the box would cascade-delete this account on reuse while Stripe keeps charging.",
        409
      );
    }

    const plan = resolveDeployedVpsSize(business.tier, business.vps_size);
    await releaseVpsToPool({
      vmId,
      plan,
      hostingerBillingSubscriptionId: subscription?.hostinger_billing_subscription_id ?? null,
      notes:
        `released to pool by admin ${admin.email ?? admin.userId} from ${businessId} ` +
        `(${business.name}); the account stays live until a new signup adopts the box, ` +
        `then it is cascade-deleted`
    });

    logger.info("admin.release-vps-to-pool: box marked available", {
      adminEmail: admin.email,
      businessId,
      virtualMachineId: vmId,
      plan
    });

    return successResponse({ released: true, vmId, plan });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
