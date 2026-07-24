/**
 * POST /api/book/submit — public booking submission for the self-serve
 * booking page (/book/<token>).
 *
 * Cookie-free, CSRF-exempt (see src/proxy.ts): authenticated by the page's
 * capability token alone. The requested start is re-verified against live
 * availability before the write; the booking core's dedupe ledger and
 * attendee guard make the write itself idempotent.
 *
 * Body: { token, startIso, durationMinutes, name, phone, email, note? }
 */

import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitDurable, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";
import { submitPublicBooking } from "@/lib/booking-page/service";

export const dynamic = "force-dynamic";

// Bookings are real calendar writes plus (when connected) a Zoom meeting —
// tighter than the slot read. Durable so the quota binds fleet-wide.
const SUBMIT_RATE = { interval: 10 * 60 * 1000, maxRequests: 10 };

const bodySchema = z.object({
  token: z.string().max(200),
  startIso: z.string().max(64),
  durationMinutes: z.number().int(),
  name: z.string().max(300),
  phone: z.string().max(64),
  email: z.string().max(320),
  note: z.string().max(2000).optional()
});

export async function POST(request: Request) {
  try {
    const ip = rateLimitIdentifierFromRequest(request);
    const limiter = await rateLimitDurable(`booking-submit:${ip}`, SUBMIT_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, please wait a moment.", 429);
    }

    const body = bodySchema.parse(await request.json());
    const result = await submitPublicBooking(body.token, {
      startIso: body.startIso,
      durationMinutes: body.durationMinutes,
      name: body.name,
      phone: body.phone,
      email: body.email,
      note: body.note
    });
    if (!result.ok) {
      if (result.detail === "not_found") {
        return errorResponse("NOT_FOUND", "This booking page is not available.");
      }
      if (result.detail === "invalid_request" || result.detail === "invalid_duration") {
        return errorResponse("VALIDATION_ERROR", "Please check your details and try again.");
      }
      if (result.detail === "slot_taken") {
        // Distinct code so the client re-fetches slots and asks for a new pick.
        return errorResponse("CONFLICT", "That time was just taken, please pick another.", 409);
      }
      return errorResponse("CONFLICT", "Booking failed, please try again.", 503);
    }
    return successResponse({
      startIso: result.startIso,
      endIso: result.endIso,
      startLocal: result.startLocal,
      zoomJoinUrl: result.zoomJoinUrl
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
