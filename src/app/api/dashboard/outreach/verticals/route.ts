/**
 * Prospecting: calling off a whole kind of business.
 *
 *   POST /api/dashboard/outreach/verticals  { businessId, vertical }
 *
 * Removing a trade from the search terms only stops the NEXT discovery pass.
 * Everything that trade already produced stays in the queue and, in automatic
 * mode, still goes out. This retires all of it in one press: prospects waiting
 * to be drafted and drafts waiting to be read, skipped rather than deleted, so
 * their domains stay out of future discovery.
 *
 * Nothing already sent is touched, and there is no tier gate: stopping outreach
 * costs nothing and is exactly what a downgraded tenant should still be able to
 * do.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { skipVertical } from "@/lib/outreach/owner";

export const dynamic = "force-dynamic";

const RATE = { interval: 60 * 1000, maxRequests: 20 };

const bodySchema = z.object({
  businessId: z.string().uuid(),
  /** The trade as the funnel reports it, including the "(unknown)" bucket. */
  vertical: z.string().trim().min(1).max(120)
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_settings");

    const limiter = rateLimit(`outreach-vertical:${body.data.businessId}`, RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const skipped = await skipVertical(body.data.businessId, body.data.vertical);
    return successResponse({ vertical: body.data.vertical, skipped });
  } catch (err) {
    return handleRouteError(err);
  }
}
