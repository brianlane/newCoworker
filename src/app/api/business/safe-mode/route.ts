/**
 * Safe Mode toggle.
 *
 * Refuses to enable when `business_telnyx_settings.forward_to_e164` is missing
 * — Safe Mode *forwards* customer SMS/voice to the owner's cell, so without a
 * number there is nowhere to forward. The dashboard UI enforces the same
 * precondition client-side; this is the belt-and-suspenders server gate.
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { setCustomerChannelsEnabled } from "@/lib/db/businesses";
import { getBusinessTelnyxSettings } from "@/lib/db/telnyx-routes";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  enabled: z.boolean()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const body = bodySchema.parse(await request.json());

    if (!user.isAdmin) await requireOwner(body.businessId);

    // `enabled` in the request = Safe Mode ON (inverse of customer_channels_enabled).
    // When turning Safe Mode ON we must have a forwarding number; turning it
    // OFF (back to normal) is always allowed.
    if (body.enabled) {
      const settings = await getBusinessTelnyxSettings(body.businessId);
      const forward = settings?.forward_to_e164?.trim() ?? "";
      if (!forward) {
        return errorResponse(
          "VALIDATION_ERROR",
          "Set a forwarding phone number before turning on Safe Mode."
        );
      }
    }

    await setCustomerChannelsEnabled(body.businessId, !body.enabled);
    return successResponse({ safeMode: body.enabled });
  } catch (err) {
    return handleRouteError(err);
  }
}
