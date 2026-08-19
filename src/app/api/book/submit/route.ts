/**
 * POST /api/book/submit, public booking submission for the self-serve
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

// Bookings are real calendar writes plus (when connected) a Zoom meeting,
// tighter than the slot read. Durable so the quota binds fleet-wide.
const SUBMIT_RATE = { interval: 10 * 60 * 1000, maxRequests: 10 };

const bodySchema = z.object({
  token: z.string().max(200),
  startIso: z.string().max(64),
  durationMinutes: z.number().int(),
  name: z.string().max(300),
  phone: z.string().max(64),
  email: z.string().max(320),
  note: z.string().max(2000).optional(),
  // "Text me if an earlier time opens up" (cancellation waitlist opt-in).
  notifyEarlier: z.boolean().optional(),
  /** Browser IANA zone, for the confirmation email's "your time" line. */
  visitorTimeZone: z.string().max(64).optional(),
  /** Locale of the page the visitor booked on. */
  locale: z.string().max(8).optional(),
  /** The meeting being booked (/book/<page>/<typeSlug>). */
  meetingTypeSlug: z.string().max(60).optional(),
  /** Answers to the page's intake questions, keyed by question id. */
  intakeAnswers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional()
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
      note: body.note,
      notifyEarlier: body.notifyEarlier,
      visitorTimeZone: body.visitorTimeZone,
      locale: body.locale,
      meetingTypeSlug: body.meetingTypeSlug,
      intakeAnswers: body.intakeAnswers
    });
    if (!result.ok) {
      if (result.detail === "not_found") {
        return errorResponse("NOT_FOUND", "This booking page is not available.");
      }
      if (result.detail === "invalid_request" || result.detail === "invalid_duration") {
        return errorResponse("VALIDATION_ERROR", "Please check your details and try again.");
      }
      if (result.detail === "slot_taken") {
        // Covers both a raced slot and a day that just hit its booking cap:
        // the client re-fetches availability (where the slot or whole day is
        // gone) and shows the "no longer available" copy, accurate for both.
        return errorResponse("CONFLICT", "That time is no longer available.", 409);
      }
      if (result.detail === "payment_required") {
        // Collection is not built yet; the visitor should call rather than
        // walk away thinking the business is broken.
        return errorResponse(
          "CONFLICT",
          "This appointment requires payment, which is not yet available online. Please contact the business to book.",
          409
        );
      }
      if (result.detail === "missing_answers") {
        // A stale form (the owner added a required question while it sat
        // open). 400, NOT 422: the client reads 422 as "you already have an
        // appointment", and this is a fixable form problem.
        return errorResponse(
          "VALIDATION_ERROR",
          "Please answer the required questions and try again.",
          400
        );
      }
      if (result.detail === "already_booked") {
        // Deliberate policy: one upcoming appointment per person on the
        // public page. 422 so the client shows the dedicated explanation.
        return errorResponse(
          "CONFLICT",
          "You already have an upcoming appointment with this business.",
          422
        );
      }
      return errorResponse("CONFLICT", "Booking failed, please try again.", 503);
    }
    return successResponse({
      startIso: result.startIso,
      endIso: result.endIso,
      startLocal: result.startLocal,
      videoJoinUrl: result.videoJoinUrl,
      manageLink: result.manageLink
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
