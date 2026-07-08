/**
 * Shared NewCoworker calendar share action.
 *
 * POST /api/dashboard/employees/share-calendar?businessId=<uuid>
 *        → { calendarId, sharedWith, added, failed }
 *
 * Creates the dedicated NewCoworker calendar on the owner's connected
 * account if it doesn't exist yet, then grants read access to every roster
 * member with an email that hasn't already been granted. Re-running after
 * adding employees only grants the new ones.
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "manage_settings"); admins bypass.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { shareSharedCalendarWithEmployees } from "@/lib/calendar-tools/shared-calendar";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 10 };

const querySchema = z.object({ businessId: z.string().uuid() });

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

    const limiter = rateLimit(`employees-share-calendar:${businessId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const result = await shareSharedCalendarWithEmployees(businessId);
    if (!result.ok) {
      return result.detail === "calendar_not_connected"
        ? errorResponse(
            "VALIDATION_ERROR",
            "Connect a calendar in Integrations first, then try again.",
            400
          )
        : errorResponse(
            "INTERNAL_SERVER_ERROR",
            "Calendar sharing failed, try again shortly.",
            500
          );
    }

    return successResponse({
      calendarId: result.calendarId,
      sharedWith: result.sharedWith,
      added: result.added,
      failed: result.failed
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
