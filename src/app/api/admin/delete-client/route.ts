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
import { after } from "next/server";
import { requireAdmin, findAuthUserIdByEmail } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import { planLifecycleAction } from "@/lib/billing/lifecycle";
import {
  executeLifecyclePlanFastPhase,
  executeLifecyclePlanSlowPhase
} from "@/lib/billing/lifecycle-executor";
import { deleteBusiness, getBusiness } from "@/lib/db/businesses";
import { logAdminAction } from "@/lib/admin/audit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  HostingerClient,
  HostingerApiError,
  DEFAULT_HOSTINGER_BASE_URL
} from "@/lib/hostinger/client";
import { logger } from "@/lib/logger";

// Vercel Pro allows up to 300s. The admin force-cancel flow's slow
// phase (SSH backup + Hostinger snapshot/stop/billing-cancel + owner
// emails) runs post-response via the split-phase executor, but we keep
// a generous ceiling as a safety net so the serverless function isn't
// torn down mid-background-work on large tenants. Without this we'd
// fall back to the platform default and operators would see Stripe-
// canceled-but-VPS-still-alive states. Mirrors the `/api/billing/cancel`
// + `/api/admin/force-refund` pattern.
export const maxDuration = 300;

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
        // Disable the owner's login BEFORE deleting the business row.
        // Previous order (delete business → delete auth user) made the
        // login-disable promise best-effort with no recovery: if the
        // auth-delete failed for a non-"not found" reason, the operator
        // had no way to retry from this endpoint because a follow-up
        // call would 404 (the business row is already gone). Now we
        // delete the auth user first so a transient Supabase auth
        // failure leaves both rows intact and the operator can retry
        // the whole DELETE. A 404-equivalent (user already gone) is
        // tolerated since the desired end-state is "owner can't log
        // in", which a missing user already satisfies.
        let authDeleteFailed = false;
        if (ownerAuthUserId) {
          try {
            const db = await createSupabaseServiceClient();
            const { error } = await db.auth.admin.deleteUser(ownerAuthUserId);
            if (error) {
              const message = error.message ?? String(error);
              if (!/not found|does not exist/i.test(message)) {
                authDeleteFailed = true;
                logger.error("admin.delete-client: auth user delete failed; aborting before business-row delete", {
                  adminEmail: admin.email,
                  businessId: body.businessId,
                  supabaseUserId: ownerAuthUserId,
                  error: message
                });
              }
            }
          } catch (err) {
            authDeleteFailed = true;
            logger.error("admin.delete-client: auth user delete threw; aborting before business-row delete", {
              adminEmail: admin.email,
              businessId: body.businessId,
              supabaseUserId: ownerAuthUserId,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
        if (authDeleteFailed) {
          // Surface the failure to the operator so they can retry the
          // whole DELETE rather than silently leaving an active login
          // attached to a soon-to-be-deleted business row.
          return errorResponse(
            "INTERNAL_SERVER_ERROR",
            "Auth user delete failed; business row preserved for retry",
            500
          );
        }
        await deleteBusiness(body.businessId);
        logger.info("admin.delete-client: deleted subscription-less business", {
          adminEmail: admin.email,
          businessId: body.businessId,
          ownerEmail: business.owner_email ?? null,
          authUserDeleted: Boolean(ownerAuthUserId)
        });
        // Audit with businessId in the payload only: the businesses row is
        // gone, so an FK-stamped system_logs row would fail to insert.
        await logAdminAction({
          adminEmail: admin.email,
          action: "delete_client",
          detail: {
            businessId: body.businessId,
            businessName: business.name,
            mode: "hard_delete_subscriptionless"
          }
        });
        return successResponse({ deleted: true });
      }
      return errorResponse("NOT_FOUND", ctxRes.reason, 404);
    }

    const planResult = planLifecycleAction({ type: "adminForceCancel" }, ctxRes.context);
    if (!planResult.ok) {
      return errorResponse("CONFLICT", planResult.reason, 409);
    }

    // `ctxRes.vpsHost` is the canonical top-level field across every
    // lifecycle-plan caller (`/api/billing/cancel`, `/reactivate`, the
    // Stripe webhook, the grace-sweep cron). The loader populates both
    // `ctxRes.vpsHost` and `ctxRes.context.vpsHost` to the same value
    // today, but reading from the top-level keeps every executor caller
    // on a single convention so a future loader-shape refactor can't
    // silently drop the field on this path.
    const extra = {
      businessId: body.businessId,
      vpsHost: ctxRes.vpsHost,
      customerProfileId: ctxRes.context.subscription.customer_profile_id
    };

    // Split-phase execution mirroring `/api/billing/cancel`: the fast
    // phase (Stripe cancel + DB updates including auth-user delete +
    // mark_business_wiped) runs inline so the operator gets a
    // definitive answer and the business row is flipped to wiped
    // before we return. The slow phase (SSH backup, Hostinger
    // snapshot/stop/billing-cancel, owner emails) runs post-response
    // via `next/server` `after()` so the serverless runtime keeps the
    // function alive for minutes-long teardown — a synchronous
    // `await` here would otherwise time out on real tenants and leave
    // Stripe canceled but the VPS still running with Hostinger billing
    // active. The grace-sweep cron is the backstop for any individual
    // Hostinger step that fails mid-background.
    //
    // Auth-delete vs slow-phase email ordering: the fast phase runs
    // `delete_auth_user` BEFORE the slow phase fires the operator/owner
    // emails. This is intentional and benign — the email step pulls the
    // recipient address from `business.owner_email` (which we kept on
    // the row even after wiping) rather than from the just-deleted
    // Supabase auth user, so the email still goes through. The
    // executor's `delete_auth_user` op also tolerates a "user not
    // found" response, so an idempotent retry of the fast phase
    // (rare but possible if the slow phase failed and an operator
    // re-runs the DELETE) is safe and won't double-error.
    let fastResult;
    try {
      fastResult = await executeLifecyclePlanFastPhase(planResult.plan, extra);
    } catch (err) {
      logger.error("admin.delete-client: fast-phase failed", {
        adminEmail: admin.email,
        businessId: body.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      return errorResponse("INTERNAL_SERVER_ERROR", "Force cancel failed; please retry", 500);
    }

    after(async () => {
      try {
        await executeLifecyclePlanSlowPhase(planResult.plan, fastResult);
      } catch (err) {
        logger.error("admin.delete-client: slow-phase failed (background)", {
          adminEmail: admin.email,
          businessId: body.businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    });

    logger.info("admin.delete-client: adminForceCancel complete", {
      adminEmail: admin.email,
      businessId: body.businessId,
      ownerEmail: business.owner_email ?? null
    });

    await logAdminAction({
      adminEmail: admin.email,
      action: "delete_client",
      businessId: body.businessId,
      detail: { businessName: business.name, mode: "admin_force_cancel" }
    });

    return successResponse({ deleted: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
