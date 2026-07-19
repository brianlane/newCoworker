import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { getChannelSettings, upsertChannelSettings } from "@/lib/db/channel-settings";
import { rcsTierAllowed } from "@/lib/telnyx/messaging";
import { insertCoworkerLog } from "@/lib/db/logs";
import { logger } from "@/lib/logger";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  /** Telnyx RCS agent id; null/blank clears it. */
  rcsAgentId: z.string().max(200).nullable(),
  rcsEnabled: z.boolean()
});

/**
 * Admin toggle for a tenant's RCS channel (`business_channel_settings`) —
 * the operator console behind the "Messaging channel (RCS)" card on the
 * admin business page. Replaces the raw-SQL enable/disable path used during
 * the Jul 2026 testing phase.
 *
 * Deliberately NOT tier-gated: the send-time gate (`rcsTierAllowed`,
 * enterprise-only) is the source of truth, so a row written for a
 * lower-tier tenant is inert (sends stay plain SMS). The response carries
 * `tierAllows` so the card can warn instead of silently doing nothing.
 * Audit-logged to coworker_logs.
 */
export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = bodySchema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    const previous = await getChannelSettings(body.businessId);
    const saved = await upsertChannelSettings(body.businessId, {
      rcsAgentId: body.rcsAgentId,
      rcsEnabled: body.rcsEnabled
    });

    try {
      await insertCoworkerLog({
        id: crypto.randomUUID(),
        business_id: body.businessId,
        task_type: "data_flow",
        status: "success",
        log_payload: {
          action: "rcs_channel_updated",
          rcsEnabled: saved.rcsEnabled,
          rcsAgentId: saved.rcsAgentId,
          previous
        }
      });
    } catch (err) {
      // Audit logging is best-effort — the settings row is already updated.
      logger.warn("rcs-channel: audit log insert failed", {
        businessId: body.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    return successResponse({
      businessId: body.businessId,
      rcsAgentId: saved.rcsAgentId,
      rcsEnabled: saved.rcsEnabled,
      tierAllows: rcsTierAllowed(business.tier)
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
