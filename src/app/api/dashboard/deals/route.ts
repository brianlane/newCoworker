/**
 * Deals (a lead's money view).
 *
 * GET  /api/dashboard/deals?businessId=<uuid>
 *        → { deals: DealWithContact[] } (newest first; the board buckets by
 *          status client-side)
 *
 * POST /api/dashboard/deals?businessId=<uuid>
 *        body: dealCreateSchema → { deal }
 *
 * Auth: viewing needs view_dashboard (staff work the board); creating needs
 * manage_settings (manager+), same bar as the segments and pipeline routes.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { dealCreateSchema } from "@/lib/deals/core";
import { DealError, createDeal, listDealsWithContacts } from "@/lib/deals/db";

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };
const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const querySchema = z.object({ businessId: z.string().uuid() });

/** Map a typed lib failure onto the right HTTP class (route-local; Next
 * route modules may only export handlers). */
function dealErrorResponse(err: DealError) {
  if (err.code === "not_found") return errorResponse("NOT_FOUND", err.message);
  if (err.code === "transition") return errorResponse("CONFLICT", err.message);
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

    const limiter = rateLimit(`deals:${businessId}:${user.userId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    return successResponse({ deals: await listDealsWithContacts(businessId) });
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

    const limiter = rateLimit(`deals-write:${businessId}:${user.userId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many edits, slow down.", 429);
    }

    const body = dealCreateSchema.parse(await request.json());

    try {
      const deal = await createDeal(businessId, body, user.userId ?? null);
      return successResponse({ deal });
    } catch (err) {
      if (err instanceof DealError) return dealErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
