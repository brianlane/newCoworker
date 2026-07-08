import { z } from "zod";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
import { insertVpsPostureReport } from "@/lib/db/vps-posture";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  checks: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        ok: z.boolean(),
        detail: z.string().max(1000).optional()
      })
    )
    .min(1)
    .max(50)
});

/**
 * Box → platform posture report (heartbeat cron). Auth mirrors
 * /api/provisioning/progress: the bearer must be a gateway token bound to
 * this businessId (per-tenant token; the shared fallback still verifies for
 * not-yet-migrated boxes). Drift (any failed check) is persisted, logged,
 * and emitted as a `vps_posture_drift` telemetry event for alerting — it
 * never auto-pauses the tenant (BYOS customers have root; false positives
 * are possible).
 */
export async function POST(request: Request) {
  try {
    const parsed = bodySchema.parse(await request.json());

    const authorized = await verifyGatewayTokenForBusiness(request, parsed.businessId);
    if (!authorized) {
      return errorResponse("UNAUTHORIZED", "Invalid gateway token", 401);
    }

    const ok = parsed.checks.every((c) => c.ok);
    const report = await insertVpsPostureReport({
      businessId: parsed.businessId,
      ok,
      checks: parsed.checks
    });

    if (!ok) {
      const failed = parsed.checks.filter((c) => !c.ok);
      logger.warn("VPS posture drift reported", {
        businessId: parsed.businessId,
        failed: failed.map((c) => c.name)
      });
      // Best-effort telemetry: alerting reads telemetry_events; a transient
      // RPC failure must not reject the box's report (the row above is the
      // durable record).
      try {
        const db = await createSupabaseServiceClient();
        await db.rpc("telemetry_record", {
          p_event_type: "vps_posture_drift",
          p_payload: {
            business_id: parsed.businessId,
            report_id: report.id,
            failed: failed.map((c) => ({ name: c.name, detail: c.detail ?? "" }))
          }
        });
      } catch (err) {
        logger.warn("vps_posture_drift telemetry emit failed", {
          businessId: parsed.businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return successResponse({ received: true, ok });
  } catch (err) {
    return handleRouteError(err);
  }
}
