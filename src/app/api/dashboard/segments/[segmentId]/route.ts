/**
 * Manage one Smart List.
 *
 * PATCH  /api/dashboard/segments/:segmentId?businessId=<uuid>
 *   body: { name?, filters? } → { segment }
 * DELETE /api/dashboard/segments/:segmentId?businessId=<uuid>
 *   Deletes the saved view; contacts are untouched.
 *
 * Auth: manage_settings (manager+), same bar as the pipeline boards.
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
  deleteContactSegment,
  updateContactSegment
} from "@/lib/segments/db";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 30 };

const querySchema = z.object({ businessId: z.string().uuid() });
const paramsSchema = z.object({ segmentId: z.string().uuid() });

const patchBodySchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_SEGMENT_NAME_LENGTH).optional(),
    filters: segmentFiltersSchema.optional()
  })
  .refine((b) => b.name !== undefined || b.filters !== undefined, {
    message: "Nothing to update; set name and/or filters."
  });

type Ctx = { params: Promise<{ segmentId: string }> };

function segmentErrorResponse(err: SegmentError) {
  if (err.code === "not_found") return errorResponse("NOT_FOUND", err.message);
  return errorResponse("VALIDATION_ERROR", err.message);
}

async function authorize(request: Request, params: Ctx["params"]) {
  const user = await getAuthUser();
  if (!user) return { error: errorResponse("UNAUTHORIZED", "Authentication required") };

  const url = new URL(request.url);
  const { businessId } = querySchema.parse({
    businessId: url.searchParams.get("businessId") ?? ""
  });
  const { segmentId } = paramsSchema.parse(await params);
  if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

  const limiter = rateLimit(`segments-write:${businessId}:${user.userId}`, WRITE_RATE);
  if (!limiter.success) {
    return { error: errorResponse("CONFLICT", "Too many edits, slow down.", 429) };
  }
  return { businessId, segmentId };
}

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const auth = await authorize(request, params);
    if ("error" in auth) return auth.error;

    const body = patchBodySchema.parse(await request.json());
    try {
      const segment = await updateContactSegment(auth.businessId, auth.segmentId, body);
      return successResponse({ segment });
    } catch (err) {
      if (err instanceof SegmentError) return segmentErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const auth = await authorize(request, params);
    if ("error" in auth) return auth.error;

    try {
      await deleteContactSegment(auth.businessId, auth.segmentId);
      return successResponse({ deleted: true });
    } catch (err) {
      if (err instanceof SegmentError) return segmentErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
