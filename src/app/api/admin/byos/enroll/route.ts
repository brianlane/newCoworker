import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { getSubscription } from "@/lib/db/subscriptions";
import {
  ByosEnrollmentError,
  makeByosProvisioner,
  prepareByosEnrollment,
  probeByosSsh
} from "@/lib/provisioning/byos";
import { VpsProviderValidationError, VPS_REGIONS } from "@/lib/vps/provider";
import { getLatestProvisioningStatus } from "@/lib/provisioning/progress";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { z } from "zod";

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("prepare"),
    businessId: z.string().uuid(),
    host: z.string().min(1),
    region: z.enum(VPS_REGIONS)
  }),
  z.object({
    action: z.literal("provision"),
    businessId: z.string().uuid()
  })
]);

/**
 * Admin-only BYOS enrollment (enterprise tier, SSH handover).
 *
 * `action: "prepare"` pins the business to vps_provider='byos' + region,
 * mints (or reuses) the per-box keypair, and returns the PUBLIC key for the
 * customer to append to /root/.ssh/authorized_keys on their box.
 *
 * `action: "provision"` runs a fast synchronous SSH probe (immediate
 * operator feedback), then kicks off the standard provisioning orchestrator
 * in the background with the BYOS provisioner injected — progress lands in
 * the same coworker_logs rows the admin page already renders. The enterprise
 * tier gate is enforced inside prepare (updateBusinessVpsProvider) and again
 * by the orchestrator's own provider gate.
 */
export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = bodySchema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    if (body.action === "prepare") {
      const prepared = await prepareByosEnrollment({
        businessId: body.businessId,
        host: body.host,
        region: body.region
      });
      return successResponse(prepared);
    }

    // action === "provision"
    // Provider-pin guard: the orchestrator resolves the provider from the
    // BUSINESS ROW, not from the injected provisioner — if the row were
    // still 'hostinger' (prepare never ran, or the pin was reverted) while
    // a stale BYOS key exists, the pool-adopt path could land the tenant on
    // a Hostinger box before the injected BYOS provisioner ever ran.
    if ((business.vps_provider ?? "hostinger") !== "byos") {
      return errorResponse(
        "VALIDATION_ERROR",
        `Business is pinned to vps_provider='${business.vps_provider ?? "hostinger"}', not 'byos' — run the prepare step first.`
      );
    }

    // In-flight guard: a provisioning run takes many minutes and the button
    // re-enables as soon as this response returns, so a double-click (or an
    // impatient re-try) must not start a second orchestrator against the
    // same box. The latest provisioning log row is the source of truth: a
    // recent non-terminal ("thinking") row below 100% means a run is live.
    // The window bound (30 min) lets a crashed run be retried without ops
    // surgery.
    const latest = await getLatestProvisioningStatus(body.businessId);
    if (
      latest &&
      latest.logStatus === "thinking" &&
      latest.percent < 100 &&
      Date.now() - new Date(latest.updatedAt).getTime() < 30 * 60 * 1000
    ) {
      return errorResponse(
        "CONFLICT",
        `Provisioning already in progress (${latest.phase}, ${latest.percent}%). ` +
          "Follow the provisioning logs; retry only after it fails or completes."
      );
    }

    const { host } = await probeByosSsh(body.businessId);

    // Fire-and-forget, mirroring the Stripe-webhook provisioning kick: the
    // run takes many minutes (bootstrap + deploy) and the admin page follows
    // progress via the provisioning-log card. The orchestrator records its
    // own terminal `failed` row on any error; the catch here only guards
    // against an unhandled rejection taking the server process down.
    const subscription = await getSubscription(body.businessId);
    const { orchestrateProvisioning } = await import("@/lib/provisioning/orchestrate");
    orchestrateProvisioning(
      {
        businessId: body.businessId,
        tier: business.tier,
        vpsSize: business.vps_size ?? null,
        billingPeriod: subscription?.billing_period ?? null,
        ownerEmail: business.owner_email
      },
      { vpsProvisioner: makeByosProvisioner() }
    ).catch((err) => {
      logger.error("BYOS provisioning run failed", {
        businessId: body.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    });

    return successResponse({ started: true, host });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    if (err instanceof ByosEnrollmentError || err instanceof VpsProviderValidationError) {
      return errorResponse("VALIDATION_ERROR", err.message);
    }
    return handleRouteError(err);
  }
}
