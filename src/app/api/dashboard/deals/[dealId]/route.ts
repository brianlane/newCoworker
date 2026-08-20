/**
 * Manage one deal.
 *
 * PATCH  /api/dashboard/deals/:dealId?businessId=<uuid>
 *   body: dealPatchSchema → { deal } (a status change is validated against
 *   the funnel rules and stamps/clears won_at & lost_at)
 * DELETE /api/dashboard/deals/:dealId?businessId=<uuid>
 *   Deletes the deal record; the contact is untouched.
 *
 * Auth: manage_settings (manager+), same bar as the segments routes.
 */

import { z } from "zod";
import type { NextResponse } from "next/server";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { dealPatchSchema } from "@/lib/deals/core";
import { DealError, deleteDeal, updateDeal } from "@/lib/deals/db";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 30 };

const querySchema = z.object({ businessId: z.string().uuid() });
const paramsSchema = z.object({ dealId: z.string().uuid() });

type Ctx = { params: Promise<{ dealId: string }> };

function dealErrorResponse(err: DealError) {
  if (err.code === "not_found") return errorResponse("NOT_FOUND", err.message);
  if (err.code === "transition") return errorResponse("CONFLICT", err.message);
  return errorResponse("VALIDATION_ERROR", err.message);
}

/** Explicitly annotated so `"error" in auth` narrows cleanly (an inferred
 * union would synthesize `error?: undefined` onto the success branch). */
async function authorize(
  request: Request,
  params: Ctx["params"]
): Promise<{ error: NextResponse } | { businessId: string; dealId: string }> {
  const user = await getAuthUser();
  if (!user) return { error: errorResponse("UNAUTHORIZED", "Authentication required") };

  const url = new URL(request.url);
  const { businessId } = querySchema.parse({
    businessId: url.searchParams.get("businessId") ?? ""
  });
  const { dealId } = paramsSchema.parse(await params);
  if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

  const limiter = rateLimit(`deals-write:${businessId}:${user.userId}`, WRITE_RATE);
  if (!limiter.success) {
    return { error: errorResponse("CONFLICT", "Too many edits, slow down.", 429) };
  }
  return { businessId, dealId };
}

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const auth = await authorize(request, params);
    if ("error" in auth) return auth.error;

    const body = dealPatchSchema.parse(await request.json());
    try {
      const deal = await updateDeal(auth.businessId, auth.dealId, body);
      return successResponse({ deal });
    } catch (err) {
      if (err instanceof DealError) return dealErrorResponse(err);
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
      await deleteDeal(auth.businessId, auth.dealId);
      return successResponse({ deleted: true });
    } catch (err) {
      if (err instanceof DealError) return dealErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
