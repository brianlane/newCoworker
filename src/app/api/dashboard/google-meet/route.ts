/**
 * Google Meet on bookings: the owner's on/off switch.
 *
 * PUT { businessId, enabled } → flip `businesses.google_meet_enabled`.
 *
 * There is no GET: the Google integration page server-renders the current
 * value out of `loadIntegrationsContext`, so a read endpoint would be a
 * second source of truth for one boolean.
 *
 * `manage_settings` (owner or manager; platform admin passes) and an explicit
 * businessId, so an admin in view-as flips the tenant they are viewing rather
 * than their own. Same shape as the branding route next door.
 */
import { z } from "zod";
import { requireBusinessRole } from "@/lib/auth";
import { updateGoogleMeetEnabled } from "@/lib/db/businesses";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  enabled: z.boolean()
});

export async function PUT(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    await requireBusinessRole(body.businessId, "manage_settings");
    await updateGoogleMeetEnabled(body.businessId, body.enabled);
    return successResponse({ enabled: body.enabled });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
