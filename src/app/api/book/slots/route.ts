/**
 * POST /api/book/slots — public slot listing for the self-serve booking
 * page (/book/<token>).
 *
 * Cookie-free, CSRF-exempt (see src/proxy.ts): authenticated by the page's
 * capability token alone. Returns coarse 30-minute slot starts only, never
 * event data, so the endpoint cannot be used to probe calendar contents.
 *
 * Body: { token: "ncb_…", durationMinutes: 15 | 30 | 60 }
 */

import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitDurable, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";
import { listPublicSlots } from "@/lib/booking-page/service";

export const dynamic = "force-dynamic";

// Slot reads are cheap but each one fans out to the provider free/busy
// API — keep one IP from hammering it. Durable (Postgres-backed) so the
// quota binds fleet-wide instead of per Vercel isolate.
const SLOTS_RATE = { interval: 60 * 1000, maxRequests: 30 };

const bodySchema = z.object({
  token: z.string().max(200),
  durationMinutes: z.number().int()
});

export async function POST(request: Request) {
  try {
    const ip = rateLimitIdentifierFromRequest(request);
    const limiter = await rateLimitDurable(`booking-slots:${ip}`, SLOTS_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, please wait a moment.", 429);
    }

    const body = bodySchema.parse(await request.json());
    const result = await listPublicSlots(body.token, body.durationMinutes);
    if (!result.ok) {
      if (result.detail === "not_found") {
        return errorResponse("NOT_FOUND", "This booking page is not available.");
      }
      if (result.detail === "invalid_duration") {
        return errorResponse("VALIDATION_ERROR", "That meeting length is not offered.");
      }
      return errorResponse("CONFLICT", "Availability is temporarily unavailable.", 503);
    }
    return successResponse({
      timezone: result.timezone,
      durationMinutes: result.durationMinutes,
      slots: result.slots
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
