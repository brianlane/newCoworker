import { requireAdmin } from "@/lib/auth";
import {
  getBusiness,
  updateDataRetentionDays,
  MIN_DATA_RETENTION_DAYS
} from "@/lib/db/businesses";
import { insertCoworkerLog } from "@/lib/db/logs";
import { logger } from "@/lib/logger";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  /** Days to keep content history; null clears the window (keep forever). */
  retentionDays: z.number().int().min(MIN_DATA_RETENTION_DAYS).nullable()
});

/**
 * Admin lever for a tenant's content-retention window (security review G6).
 * The daily data-retention-sweep enforces it; contacts are exempt (the
 * deletion route handles full per-person erasure). Audit-logged to
 * coworker_logs.
 */
export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = bodySchema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    await updateDataRetentionDays(body.businessId, body.retentionDays);

    try {
      await insertCoworkerLog({
        id: crypto.randomUUID(),
        business_id: body.businessId,
        task_type: "data_flow",
        status: "success",
        log_payload: {
          action: "data_retention_updated",
          retentionDays: body.retentionDays,
          previous: business.data_retention_days ?? null
        }
      });
    } catch (err) {
      // Audit logging is best-effort here — the change itself succeeded and
      // is visible on the business row.
      logger.warn("data-retention: audit log insert failed", {
        businessId: body.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    return successResponse({
      businessId: body.businessId,
      retentionDays: body.retentionDays,
      note:
        body.retentionDays === null
          ? "Retention window cleared — content history is kept forever."
          : `Content history older than ${body.retentionDays} days is pruned by the daily sweep.`
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
