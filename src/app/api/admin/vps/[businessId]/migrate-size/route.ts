/**
 * POST /api/admin/vps/:businessId/migrate-size
 *
 * Admin-only elective hardware migration (escalate/de-escalate a tenant
 * between kvm1/kvm2/kvm4/kvm8 with no entitlement change) — the panel
 * replacement for debug/migrate-vps-size.ts.
 *
 * The migration buys hardware and runs minutes of unattended work
 * (snapshot → backup → provision → restore → old-box teardown), so the
 * route answers 202 immediately and runs the migration via Next's
 * `after()` (Vercel `waitUntil`), same as the cancel route's slow phase.
 * Progress lands in the ops inbox: a "started" email up front and a
 * terminal "completed"/"failed" email from the migration itself.
 *
 * Fail-closed by construction (see src/lib/vps/migrate-size.ts): any
 * failure before cutover leaves the old box serving; any failure after
 * leaves it running + renewing until an operator finishes manually.
 */

import { after } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateBusinessVpsSize } from "@/lib/db/businesses";
import { getSubscription, updateSubscription } from "@/lib/db/subscriptions";
import { getActiveVpsSshKey } from "@/lib/db/vps-ssh-keys";
import { backupBusinessData, restoreBusinessData } from "@/lib/hostinger/data-migration";
import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "@/lib/hostinger/client";
import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";
import { migrateBusinessVpsSize } from "@/lib/vps/migrate-size";
import { resolveDeployedVpsSize, isVpsSize } from "@/lib/vps/size";
import { sendOpsHardwareMigrationEmail } from "@/lib/email/ops-notify";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { logger } from "@/lib/logger";

// Vercel Pro ceiling — the same budget the Stripe webhook's change-plan
// migration (identical flow) already lives within.
export const maxDuration = 300;

const paramsSchema = z.object({ businessId: z.string().uuid() });
const bodySchema = z.object({ size: z.string() });

/* c8 ignore start -- env-var fallbacks: tests inject nothing here; the `??`
   defaults exist so a forgotten env var surfaces as a 401 from the API, not
   a TypeError. Mirrors lifecycle-executor.ts. */
function hostingerClient(): HostingerClient {
  return new HostingerClient({
    baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
    token: process.env.HOSTINGER_API_TOKEN ?? ""
  });
}
/* c8 ignore stop */

export async function POST(
  request: Request,
  ctx: { params: Promise<{ businessId: string }> }
) {
  try {
    const admin = await requireAdmin();
    const { businessId } = paramsSchema.parse(await ctx.params);
    const { size } = bodySchema.parse(await request.json());

    if (!isVpsSize(size)) {
      return errorResponse("VALIDATION_ERROR", "size must be one of kvm1|kvm2|kvm4|kvm8");
    }

    const business = await getBusiness(businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");
    if (business.tier !== "starter" && business.tier !== "standard") {
      return errorResponse("VALIDATION_ERROR", "Enterprise hardware is managed manually");
    }
    const currentSize = resolveDeployedVpsSize(business.tier, business.vps_size);
    if (currentSize === size) {
      return errorResponse("VALIDATION_ERROR", `Business is already on ${size}`);
    }

    const requestedBy = admin.email ?? admin.userId;
    logger.info("admin hardware migration requested", {
      businessId,
      fromSize: currentSize,
      toSize: size,
      requestedBy
    });

    // Run the multi-minute migration after the response is sent. All
    // progress (including failures) is emailed to the ops inbox by the
    // migration itself.
    after(async () => {
      try {
        const outcome = await migrateBusinessVpsSize(
          { businessId, targetSize: size, requestedBy },
          {
            getBusiness,
            getSubscription,
            updateSubscription,
            updateBusinessVpsSize,
            getActiveVpsSshKey,
            hostinger: hostingerClient(),
            backupBusinessData,
            restoreBusinessData,
            orchestrateProvisioning,
            sendOpsEmail: sendOpsHardwareMigrationEmail
          }
        );
        if (!outcome.ok) {
          logger.error("admin hardware migration failed (background)", {
            businessId,
            stage: outcome.stage,
            error: outcome.error
          });
        }
      } catch (err) {
        // migrateBusinessVpsSize returns failures instead of throwing; this
        // guards the unexpected (e.g. a dep constructor blowing up).
        logger.error("admin hardware migration crashed (background)", {
          businessId,
          error: err instanceof Error ? err.message : String(err)
        });
        await sendOpsHardwareMigrationEmail({
          phase: "failed",
          businessId,
          businessName: business.name,
          requestedBy,
          fromSize: currentSize,
          toSize: size,
          detail: `Unexpected crash before the migration engine could report: ${
            err instanceof Error ? err.message : String(err)
          }`
        });
      }
    });

    return successResponse(
      {
        accepted: true,
        businessId,
        fromSize: currentSize,
        toSize: size
      },
      202
    );
  } catch (err) {
    return handleRouteError(err);
  }
}
