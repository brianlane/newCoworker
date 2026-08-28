/**
 * Register one browser to receive owner alerts as Web Push.
 *
 * POST { businessId: uuid | null, subscription: PushSubscriptionJSON }
 *
 * `businessId: null` is the platform/HQ-admin scope and requires an admin.
 * A tenant scope requires `view_dashboard`, which is the staff bar: teammates
 * receive alerts today on SMS and email, so gating push higher would silently
 * make it the one channel they cannot have.
 *
 * The endpoint is host-allowlisted by `pushSubscriptionSchema` before it is
 * stored. That is an SSRF guard, not validation hygiene: the server later
 * POSTs to this value.
 */

import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { repointPushSubscription, upsertPushSubscription } from "@/lib/push/db";
import { pushSubscriptionSchema } from "@/lib/push/subscription";
import { pushAllowedForBusiness, PUSH_UPGRADE_MESSAGE } from "@/lib/push/tier-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /**
   * Absent on a ROTATION (see previousEndpoint): the service worker has no
   * idea which business the device was registered against, and guessing would
   * either 403 a tenant device or silently move it to the wrong scope.
   */
  businessId: z.string().uuid().nullable().optional(),
  /**
   * Set only by the pushsubscriptionchange handler. A selector, never
   * authentication: the session still identifies the caller and user_id is
   * part of the update predicate, so holding a leaked endpoint buys nothing.
   */
  previousEndpoint: z.string().min(1).max(2048).optional(),
  subscription: pushSubscriptionSchema
});

const SUBSCRIBE_RATE = { interval: 60 * 1000, maxRequests: 30 };

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const limiter = rateLimit(`push-subscribe:${user.userId}`, SUBSCRIBE_RATE);
    if (!limiter.success) {
      return errorResponse("VALIDATION_ERROR", "Too many subscription attempts", 429);
    }

    const body = bodySchema.parse(await request.json());
    const userAgent = request.headers.get("user-agent");

    // Rotation: move whatever scopes this person already had on the old
    // endpoint. Never creates a registration, so it needs no scope of its own.
    if (body.previousEndpoint) {
      const moved = await repointPushSubscription({
        previousEndpoint: body.previousEndpoint,
        userId: user.userId,
        subscription: body.subscription,
        userAgent
      });
      return successResponse({ subscribed: moved > 0, rotated: moved });
    }

    if (body.businessId === undefined) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }

    if (body.businessId === null) {
      // Platform scope: HQ admin devices, which receive alert_delivery_failed
      // and the liveness sweep's own findings rather than a tenant's alerts.
      if (!user.isAdmin) return errorResponse("FORBIDDEN", "Admin required", 403);
    } else {
      await requireBusinessRole(body.businessId, "view_dashboard");
      if (!(await pushAllowedForBusiness(body.businessId))) {
        return errorResponse("FORBIDDEN", PUSH_UPGRADE_MESSAGE, 403);
      }
    }

    await upsertPushSubscription({
      scope: { businessId: body.businessId },
      userId: user.userId,
      subscription: body.subscription,
      // Read from the header, never the body: the caller must not get to
      // choose the device label we show them later.
      userAgent
    });

    return successResponse({ subscribed: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
