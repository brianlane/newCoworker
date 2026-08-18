/**
 * GET /api/book/manage/slots?token=…, the times an invitee may move their
 * booking to.
 *
 * The same availability the public page offers (identical policy knobs,
 * busy sources, and degradation), addressed by the per-booking manage
 * token rather than the page ref, so the invitee never needs the page link.
 */

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitDurable, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";
import { getManagedBooking } from "@/lib/booking-page/manage";
import { listSlotsForBusiness } from "@/lib/booking-page/service";
import { getBookingByManageToken } from "@/lib/booking-page/db";
import { parseBookingManageToken } from "@/lib/booking-page/keys";

export const dynamic = "force-dynamic";

const SLOTS_RATE = { interval: 60 * 1000, maxRequests: 30 };

export async function GET(request: Request) {
  try {
    const ip = rateLimitIdentifierFromRequest(request);
    const limiter = await rateLimitDurable(`booking-manage-slots:${ip}`, SLOTS_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, please wait a moment.", 429);
    }

    const url = new URL(request.url);
    const token = parseBookingManageToken(url.searchParams.get("token"));
    if (!token) return errorResponse("NOT_FOUND", "This appointment link is no longer valid.");

    const booking = await getBookingByManageToken(token);
    if (!booking) return errorResponse("NOT_FOUND", "This appointment link is no longer valid.");

    // The view carries the duration (and the notice window), so the offer
    // matches what the invitee already holds.
    const view = await getManagedBooking(token);
    if (!view.ok) return errorResponse("NOT_FOUND", "This appointment link is no longer valid.");

    const slots = await listSlotsForBusiness(booking.business_id, view.view.durationMinutes, {
      // Offer the invitee times as if their own appointment were not there:
      // it is the one they are moving.
      excludeStartIso: booking.start_at
    });
    if (!slots.ok) {
      // Reported as a failure, not as an empty list: "no times available"
      // would send the invitee away when the real answer is "try again".
      return errorResponse("CONFLICT", "Could not load times, please try again.", 503);
    }
    return successResponse({ timezone: slots.timezone, slots: slots.slots });
  } catch (error) {
    return handleRouteError(error);
  }
}
