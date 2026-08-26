/**
 * Owner-editable staff-SMS behavior
 * (business_telnyx_settings.staff_sms_assistant_reply_enabled +
 * staff_sms_forward_to_owner_enabled).
 *
 * Controls what happens when the OWNER or a roster team member texts the
 * business number:
 *   - assistantReplyEnabled: the assistant replies in internal-assistant mode
 *     (staff mode, no lead intake, no customer profile), like the dashboard
 *     chat. Default on. This half now lives in the shared per-surface store
 *     (public.coworker_staff_mode, surface_key 'sms'), which is what the SMS
 *     webhook reads and what Settings → Coworker shows alongside every other
 *     surface. Writing the old business_telnyx_settings column here would
 *     silently do nothing.
 *   - forwardToOwnerEnabled: also relay the staff text to the owner's cell.
 *     Default off.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { setStaffSmsSettings } from "@/lib/db/telnyx-routes";
import { setStaffMode, staffModeEnabled } from "@/lib/owner-surfaces/staff-mode";

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
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_settings");

    // Forwarding to the owner's cell is SMS-specific and stays on the
    // Telnyx settings row; the reply flag is per-surface.
    const [assistantReplyEnabled, row] = await Promise.all([
      body.assistantReplyEnabled === undefined
        ? staffModeEnabled(body.businessId, "sms")
        : setStaffMode(body.businessId, "sms", body.assistantReplyEnabled),
      setStaffSmsSettings(body.businessId, {
        forwardToOwnerEnabled: body.forwardToOwnerEnabled
      })
    ]);

    return successResponse({
      assistantReplyEnabled,
      forwardToOwnerEnabled: row.staff_sms_forward_to_owner_enabled
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
