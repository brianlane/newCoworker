import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import { setAdminNotificationMutes } from "@/lib/db/admin-mutes";

/**
 * Admin-only: per-business mutes for the fleet-wide /admin/dashboard feeds
 * (Recent Activity / System Errors / Recent Alerts). Partial patches — omit
 * a field to leave that switch unchanged. Muting only hides the business
 * from the aggregate feeds; its own admin page keeps showing everything.
 */
const schema = z
  .object({
    businessId: z.string().uuid(),
    muteActivity: z.boolean().optional(),
    muteErrors: z.boolean().optional(),
    muteAlerts: z.boolean().optional()
  })
  .refine(
    (b) =>
      b.muteActivity !== undefined ||
      b.muteErrors !== undefined ||
      b.muteAlerts !== undefined,
    { message: "Provide at least one mute switch" }
  );

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = schema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    const mutes = await setAdminNotificationMutes(body.businessId, {
      muteActivity: body.muteActivity,
      muteErrors: body.muteErrors,
      muteAlerts: body.muteAlerts
    });
    return successResponse({ businessId: body.businessId, mutes });
  } catch (err) {
    return handleRouteError(err);
  }
}
