/**
 * POST /api/book/manage, the invitee's own reschedule/cancel actions for
 * one booking made on the public page (/book/manage/<token>).
 *
 * Cookie-free and CSRF-exempt (see src/proxy.ts), authenticated by the
 * per-booking capability token alone: it grants nothing beyond seeing,
 * moving, or cancelling THAT appointment. Rate limited like the submit
 * route, since both end in real calendar writes.
 *
 * Body: { token, action: "cancel" } | { token, action: "reschedule", startIso }
 */

import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitDurable, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";
import { cancelManagedBooking, rescheduleManagedBooking } from "@/lib/booking-page/manage";

export const dynamic = "force-dynamic";

const MANAGE_RATE = { interval: 10 * 60 * 1000, maxRequests: 10 };

const bodySchema = z.object({
  token: z.string().max(200),
  action: z.enum(["cancel", "reschedule"]),
  startIso: z.string().max(64).optional()
});

export async function POST(request: Request) {
  try {
    const ip = rateLimitIdentifierFromRequest(request);
    const limiter = await rateLimitDurable(`booking-manage:${ip}`, MANAGE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, please wait a moment.", 429);
    }

    const body = bodySchema.parse(await request.json());
    const result =
      body.action === "cancel"
        ? await cancelManagedBooking(body.token)
        : await rescheduleManagedBooking(body.token, body.startIso ?? "");

    if (!result.ok) {
      if (result.detail === "not_found") {
        return errorResponse("NOT_FOUND", "This appointment link is no longer valid.");
      }
      if (result.detail === "invalid_request") {
        return errorResponse("VALIDATION_ERROR", "Please pick a time and try again.");
      }
      if (result.detail === "already_past") {
        // A stale tab acting on a finished appointment: say what is true.
        return errorResponse("CONFLICT", "This appointment has already passed.", 410);
      }
      if (result.detail === "too_late") {
        // Inside the business's minimum-notice window: a person has to make
        // this change, and saying so beats a generic failure.
        return errorResponse(
          "CONFLICT",
          "This appointment is too soon to change online. Please contact the business.",
          422
        );
      }
      if (result.detail === "slot_taken") {
        return errorResponse("CONFLICT", "That time is no longer available.", 409);
      }
      if (result.detail === "needs_human") {
        // This person holds more than one upcoming appointment, so the
        // shared cores cannot be pointed at the right one. 423 (distinct
        // from the 422 notice window) so the page shows its own copy.
        return errorResponse(
          "CONFLICT",
          "This appointment needs a person to change it. Please contact the business.",
          423
        );
      }
      return errorResponse("CONFLICT", "That change did not go through, please try again.", 503);
    }

    return successResponse(
      body.action === "reschedule" && "startIso" in result ? { startIso: result.startIso } : {}
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
