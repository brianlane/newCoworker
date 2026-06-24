/**
 * Owner-editable staff-SMS behavior
 * (business_telnyx_settings.staff_sms_assistant_reply_enabled +
 * staff_sms_forward_to_owner_enabled).
 *
 * Controls what happens when the OWNER or a roster team member texts the
 * business number:
 *   - assistantReplyEnabled: the assistant replies in internal-assistant mode
 *     (staff mode — no lead intake, no customer profile), like the dashboard
 *     chat. Default on.
 *   - forwardToOwnerEnabled: also relay the staff text to the owner's cell.
 *     Default off.
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { setStaffSmsSettings } from "@/lib/db/telnyx-routes";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  assistantReplyEnabled: z.boolean().optional(),
  forwardToOwnerEnabled: z.boolean().optional()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const body = bodySchema.parse(await request.json());
    if (
      body.assistantReplyEnabled === undefined &&
      body.forwardToOwnerEnabled === undefined
    ) {
      return errorResponse("VALIDATION_ERROR", "Nothing to update.");
    }
    if (!user.isAdmin) await requireOwner(body.businessId);

    const row = await setStaffSmsSettings(body.businessId, {
      assistantReplyEnabled: body.assistantReplyEnabled,
      forwardToOwnerEnabled: body.forwardToOwnerEnabled
    });

    return successResponse({
      assistantReplyEnabled: row.staff_sms_assistant_reply_enabled,
      forwardToOwnerEnabled: row.staff_sms_forward_to_owner_enabled
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
