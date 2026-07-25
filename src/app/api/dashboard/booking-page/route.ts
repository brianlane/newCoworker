/**
 * Bookings dashboard endpoint (the /dashboard/bookings page).
 *
 * GET   /api/dashboard/booking-page?businessId=<uuid>
 *         → { page, calendarProvider, upcoming }
 * PATCH /api/dashboard/booking-page?businessId=<uuid>
 *         body: settings patch (enable, durations, notice, advance, buffer,
 *         daily cap, staff gate, description) → { page }
 * POST  /api/dashboard/booking-page?businessId=<uuid>
 *         body: { action: "rotate" } → { page }   (mints a fresh link)
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "manage_settings");
 * admins bypass the ownership check (existing dashboard convention).
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  BookingPageValidationError,
  getBookingPageForBusiness,
  listUpcomingBookings,
  rotateBookingPageToken,
  upsertBookingPage
} from "@/lib/booking-page/db";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { probeCalendarAvailability } from "@/lib/booking-page/service";

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };
const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const querySchema = z.object({ businessId: z.string().uuid() });

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  allowedDurations: z.array(z.number().int()).optional(),
  minNoticeMinutes: z.number().int().optional(),
  maxAdvanceDays: z.number().int().optional(),
  bufferMinutes: z.number().int().optional(),
  maxDailyBookings: z.number().int().nullable().optional(),
  requireStaffOnShift: z.boolean().optional(),
  description: z.string().nullable().optional(),
  waitlistEnabled: z.boolean().optional(),
  waitlistOfferTtlMinutes: z.number().int().optional(),
  slug: z.string().max(80).nullable().optional(),
  title: z.string().max(200).nullable().optional()
});

const actionSchema = z.object({ action: z.literal("rotate") });

async function authedBusinessId(request: Request): Promise<string> {
  const user = await getAuthUser();
  if (!user) throw Object.assign(new Error("Authentication required"), { status: 401 });
  const url = new URL(request.url);
  const { businessId } = querySchema.parse({ businessId: url.searchParams.get("businessId") });
  if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");
  return businessId;
}

export async function GET(request: Request) {
  try {
    const businessId = await authedBusinessId(request);
    const limiter = rateLimit(`booking-page-read:${businessId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, please wait a moment.", 429);
    }

    const [existingPage, conn, upcoming, availability] = await Promise.all([
      getBookingPageForBusiness(businessId),
      resolveCalendarConnection(businessId),
      listUpcomingBookings(businessId),
      // Live free/busy probe: surfaces a connection that can write events
      // but cannot READ availability (missing Calendar consent scope) to
      // the owner, while the public page keeps failing safe for visitors.
      probeCalendarAvailability(businessId)
    ]);

    // Auto-provision on first view: the link should already exist when the
    // owner lands on Bookings, not sit behind a create button. Enabled from
    // birth is safe because the token is unguessable until the owner shares
    // it. Vagaro/Calendly tenants are skipped: booking lives on the
    // provider's own page and the dashboard card explains that instead.
    const provider = conn?.provider ?? null;
    let page = existingPage;
    if (!page && provider !== "vagaro" && provider !== "calendly") {
      page = await upsertBookingPage(businessId, { enabled: true });
    }

    return successResponse({
      page,
      calendarProvider: provider,
      availability,
      upcoming
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const businessId = await authedBusinessId(request);
    const limiter = rateLimit(`booking-page-write:${businessId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, please wait a moment.", 429);
    }

    const patch = patchSchema.parse(await request.json());
    const page = await upsertBookingPage(businessId, patch);
    return successResponse({ page });
  } catch (error) {
    if (error instanceof BookingPageValidationError) {
      return errorResponse("VALIDATION_ERROR", error.message);
    }
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const businessId = await authedBusinessId(request);
    const limiter = rateLimit(`booking-page-write:${businessId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, please wait a moment.", 429);
    }

    actionSchema.parse(await request.json());
    const existing = await getBookingPageForBusiness(businessId);
    if (!existing) {
      return errorResponse("NOT_FOUND", "Set up the booking page before rotating its link.");
    }
    const page = await rotateBookingPageToken(businessId);
    return successResponse({ page });
  } catch (error) {
    return handleRouteError(error);
  }
}
