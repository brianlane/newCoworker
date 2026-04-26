/**
 * DELETE /api/admin/delete-client
 *
 * Rewired (PR 10 of the subscription lifecycle overhaul) to dispatch the
 * `adminForceCancel` lifecycle action instead of hard-deleting the
 * `businesses` row. This gives operators:
 *   - Proper Stripe subscription teardown + schedule release.
 *   - Hostinger billing subscription cancellation (stops the Hostinger
 *     invoice clock at the same moment we wipe the tenant).
 *   - Supabase Storage backup + snapshot cleanup.
 *   - Auth-user deletion so the owner can't log back in.
 *   - `businesses.status='wiped'` + `subscriptions.wiped_at` audit stamps.
 *
 * Unlike the self-serve cancel flow, this skips the 30-day grace window —
 * admin force-cancel is terminal the moment it returns.
 *
 * The route still returns `{ deleted: true }` for back-compat with the
 * existing admin UI button.
 */

import { z } from "zod";
import { requireAdmin, findAuthUserIdByEmail } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import { planLifecycleAction } from "@/lib/billing/lifecycle";
import { executeLifecyclePlan } from "@/lib/billing/lifecycle-executor";
import { deleteBusiness, getBusiness } from "@/lib/db/businesses";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  HostingerClient,
  HostingerApiError,
  DEFAULT_HOSTINGER_BASE_URL
} from "@/lib/hostinger/client";
import { logger } from "@/lib/logger";

const schema = z.object({
  businessId: z.string().uuid()
});

export async function DELETE(request: Request) {
  try {
    const admin = await requireAdmin();

    const body = schema.parse(await request.json());

    const business = await getBusiness(body.businessId);
    if (!business) {
      return errorResponse("NOT_FOUND", "Business not found", 404);
    }

    // Resolve the owner's auth user id so the wipe step can disable them
    // via `supabase.auth.admin.deleteUser`. Fall back to the admin's own
    // id if we can't find the owner — the executor tolerates a missing
    // owner id by skipping the auth-delete step, but we still want a best
    // effort lookup.
    const ownerAuthUserId = business.owner_email
      ? (await findAuthUserIdByEmail(business.owner_email)) ?? undefined
      : undefined;

    const ctxRes = await loadLifecycleContextForBusiness(body.businessId, {
      ownerAuthUserId
    });
    if (!ctxRes.ok) {
      if (ctxRes.reason === "subscription_not_found") {
        // Subscription-less hard delete: stop the VPS first (if any),
        // then hard-delete the business row AND disable the owner's
        // auth user so the UI promise that this "disables the owner's
        // login" holds.
        //
        // The VPS-stop step is critical for partially-completed
        // onboardings that provisioned a Hostinger VM before any
        // `subscriptions` row was inserted. Without it, the route
        // would delete the business row (severing our only DB
        // correlation) while the VM keeps running and Hostinger keeps
        // billing — there'd be no way to find or stop the orphan
        // afterward. Auth deletion is best-effort — missing users are
        // ignored, other errors are logged but don't fail the
        // operator's action since the business row is already gone at
        // that point.
        if (business.hostinger_vps_id) {
          const vmId = Number.parseInt(business.hostinger_vps_id, 10);
          if (Number.isFinite(vmId)) {
            try {
              const hostinger = new HostingerClient({
                baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
                token: process.env.HOSTINGER_API_TOKEN ?? ""
              });
              await hostinger.stopVirtualMachine(vmId);
              logger.info("admin.delete-client: stopped orphan VM (subscription-less)", {
                adminEmail: admin.email,
                businessId: body.businessId,
                virtualMachineId: vmId
              });
            } catch (err) {
              // Tolerate 404 (VM already gone) but surface other failures
              // so an operator can chase the orphan; we still proceed
              // with the business-row delete because aborting here would
              // leave the operator unable to complete the action and
              // we've already committed to the deletion path.
              if (err instanceof HostingerApiError && err.status === 404) {
                logger.info("admin.delete-client: orphan VM already gone (404)", {
                  adminEmail: admin.email,
                  businessId: body.businessId,
                  virtualMachineId: vmId
                });
              } else {
                logger.error("admin.delete-client: failed to stop orphan VM", {
                  adminEmail: admin.email,
                  businessId: body.businessId,
                  virtualMachineId: vmId,
                  error: err instanceof Error ? err.message : String(err)
                });
              }
            }
          } else {
            logger.warn("admin.delete-client: hostinger_vps_id is non-numeric; cannot stop VM", {
              adminEmail: admin.email,
              businessId: body.businessId,
              hostingerVpsId: business.hostinger_vps_id
            });
          }
        }
        await deleteBusiness(body.businessId);
        if (ownerAuthUserId) {
          try {
            const db = await createSupabaseServiceClient();
            const { error } = await db.auth.admin.deleteUser(ownerAuthUserId);
            if (error) {
              const message = error.message ?? String(error);
              if (!/not found|does not exist/i.test(message)) {
                logger.warn("admin.delete-client: auth user delete failed", {
                  adminEmail: admin.email,
                  businessId: body.businessId,
                  supabaseUserId: ownerAuthUserId,
                  error: message
                });
              }
            }
          } catch (err) {
            logger.warn("admin.delete-client: auth user delete threw", {
              adminEmail: admin.email,
              businessId: body.businessId,
              supabaseUserId: ownerAuthUserId,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
        logger.info("admin.delete-client: deleted subscription-less business", {
          adminEmail: admin.email,
          businessId: body.businessId,
          ownerEmail: business.owner_email ?? null,
          authUserDeleted: Boolean(ownerAuthUserId)
        });
        return successResponse({ deleted: true });
      }
      return errorResponse("NOT_FOUND", ctxRes.reason, 404);
    }

    const planResult = planLifecycleAction({ type: "adminForceCancel" }, ctxRes.context);
    if (!planResult.ok) {
      return errorResponse("CONFLICT", planResult.reason, 409);
    }

    await executeLifecyclePlan(planResult.plan, {
      businessId: body.businessId,
      vpsHost: ctxRes.context.vpsHost,
      customerProfileId: ctxRes.context.subscription.customer_profile_id
    });

    logger.info("admin.delete-client: adminForceCancel complete", {
      adminEmail: admin.email,
      businessId: body.businessId,
      ownerEmail: business.owner_email ?? null
    });

    return successResponse({ deleted: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
