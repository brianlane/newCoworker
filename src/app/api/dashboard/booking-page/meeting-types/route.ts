/**
 * Meeting types for the Bookings dashboard.
 *
 * GET    ?businessId=<uuid>            → { meetingTypes }
 * POST   ?businessId=<uuid>            body: a new type      → { meetingType }
 * PATCH  ?businessId=<uuid>&id=<uuid>  body: a partial edit  → { meetingType }
 * DELETE ?businessId=<uuid>&id=<uuid>                        → { ok: true }
 *
 * Auth and rate limits mirror the booking-page route: getAuthUser plus
 * requireBusinessRole(businessId, "manage_settings"), admins bypassing the
 * ownership check per the dashboard convention.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { BookingPageValidationError } from "@/lib/booking-page/db";
import {
  createMeetingType,
  deleteMeetingType,
  listMeetingTypes,
  updateMeetingType
} from "@/lib/booking-page/meeting-types";

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };
const WRITE_RATE = { interval: 60 * 1000, maxRequests: 30 };

const querySchema = z.object({ businessId: z.string().uuid() });
const idSchema = z.object({ id: z.string().uuid() });

/** Shared field shape; POST additionally requires name, slug, and duration. */
const patchSchema = z.object({
  name: z.string().max(200).optional(),
  slug: z.string().max(80).optional(),
  description: z.string().max(1000).nullable().optional(),
  durationMinutes: z.number().int().optional(),
  // Null restores inheritance of the page's questions, which is why the
  // nullable() matters here.
  intakeQuestions: z.array(z.unknown()).max(20).nullable().optional(),
  assignmentMode: z.enum(["any", "round_robin", "fixed"]).nullable().optional(),
  employeeId: z.string().uuid().nullable().optional(),
  paymentRequired: z.boolean().optional(),
  paymentAmountCents: z.number().int().nullable().optional(),
  paymentCurrency: z.string().max(8).optional(),
  enabled: z.boolean().optional(),
  hidden: z.boolean().optional(),
  sortOrder: z.number().int().optional()
});

async function authedBusinessId(request: Request): Promise<string> {
  const user = await getAuthUser();
  if (!user) throw Object.assign(new Error("Authentication required"), { status: 401 });
  const url = new URL(request.url);
  const { businessId } = querySchema.parse({ businessId: url.searchParams.get("businessId") });
  if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");
  return businessId;
}

function meetingTypeId(request: Request): string {
  const url = new URL(request.url);
  return idSchema.parse({ id: url.searchParams.get("id") }).id;
}

function limited(businessId: string, write: boolean): Response | null {
  const limiter = rateLimit(
    `booking-meeting-types-${write ? "write" : "read"}:${businessId}`,
    write ? WRITE_RATE : READ_RATE
  );
  return limiter.success
    ? null
    : errorResponse("CONFLICT", "Too many requests, please wait a moment.", 429);
}

export async function GET(request: Request) {
  try {
    const businessId = await authedBusinessId(request);
    const blocked = limited(businessId, false);
    if (blocked) return blocked;
    return successResponse({ meetingTypes: await listMeetingTypes(businessId) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const businessId = await authedBusinessId(request);
    const blocked = limited(businessId, true);
    if (blocked) return blocked;
    const patch = patchSchema.parse(await request.json());
    return successResponse({ meetingType: await createMeetingType(businessId, patch) });
  } catch (error) {
    if (error instanceof BookingPageValidationError) {
      return errorResponse("VALIDATION_ERROR", error.message);
    }
    return handleRouteError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const businessId = await authedBusinessId(request);
    const blocked = limited(businessId, true);
    if (blocked) return blocked;
    const id = meetingTypeId(request);
    const patch = patchSchema.parse(await request.json());
    return successResponse({ meetingType: await updateMeetingType(businessId, id, patch) });
  } catch (error) {
    if (error instanceof BookingPageValidationError) {
      return errorResponse("VALIDATION_ERROR", error.message);
    }
    return handleRouteError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const businessId = await authedBusinessId(request);
    const blocked = limited(businessId, true);
    if (blocked) return blocked;
    await deleteMeetingType(businessId, meetingTypeId(request));
    return successResponse({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
