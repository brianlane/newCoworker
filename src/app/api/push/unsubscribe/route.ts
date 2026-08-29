/**
 * Turn push off for one browser.
 *
 * POST { endpoint }
 *
 * No businessId: the caller's own user id is part of the update predicate, so
 * this revokes every scope THIS browser registered (a person who is both an
 * owner and an HQ admin has two rows for one device and means to clear both)
 * and cannot touch anyone else's device, even given a leaked endpoint.
 *
 * Idempotent: revoking an endpoint that does not exist, or is already
 * revoked, is a 200. The browser has already dropped its subscription by the
 * time it calls this, so reporting a failure would leave the UI stuck on a
 * device that is provably gone.
 */

import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getAuthUser } from "@/lib/auth";
import { revokePushSubscription } from "@/lib/push/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  endpoint: z.string().min(1).max(2048)
});

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const body = bodySchema.parse(await request.json());
    await revokePushSubscription(body.endpoint, "user", { userId: user.userId });

    return successResponse({ revoked: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
