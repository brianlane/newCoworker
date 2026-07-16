/**
 * Smart Lists (saved contact segments).
 *
 * GET  /api/dashboard/segments?businessId=<uuid>
 *        → { segments: ContactSegment[] } (chip order)
 *
 * POST /api/dashboard/segments?businessId=<uuid>
 *        body: { name, filters } → { segment }
 *
 * Auth: viewing needs view_dashboard (staff work the lists); creating needs
 * manage_settings (manager+), same bar as the pipeline boards.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  MAX_SEGMENT_NAME_LENGTH,
  segmentFiltersSchema
} from "@/lib/segments/core";
import {
  SegmentError,
  createContactSegment,
  listContactSegments
} from "@/lib/segments/db";

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };
const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const querySchema = z.object({ businessId: z.string().uuid() });

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(MAX_SEGMENT_NAME_LENGTH),
  filters: segmentFiltersSchema
});

/** Map a typed lib failure onto the right HTTP class (route-local; Next
 * route modules may only export handlers). */
function segmentErrorResponse(err: SegmentError) {
  if (err.code === "not_found") return errorResponse("NOT_FOUND", err.message);
  return errorResponse("VALIDATION_ERROR", err.message);
}

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });
    if (!user.isAdmin) await requireBusinessRole(businessId, "view_dashboard");

    const limiter = rateLimit(`segments:${businessId}:${user.userId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    return successResponse({ segments: await listContactSegments(businessId) });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });
    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

    const limiter = rateLimit(`segments-write:${businessId}:${user.userId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many edits, slow down.", 429);
    }

    const body = createBodySchema.parse(await request.json());

    try {
      const segment = await createContactSegment(businessId, body.name, body.filters);
      return successResponse({ segment });
    } catch (err) {
      if (err instanceof SegmentError) return segmentErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
