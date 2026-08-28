/**
 * The read receipt: an owner tapped a push notification.
 *
 * POST { endpoint, notificationId? }, from the notificationclick handler in
 * public/sw.js.
 *
 * WHY THIS ROUTE IS THE POINT OF THE WHOLE CHANNEL. Every other alert channel
 * gives us a delivery receipt (a device on a network ACKed) or an inferred
 * reply (a human answered, when they felt like answering). Neither proves
 * anyone read the alert. A notificationclick does: it fires on the owner's
 * device, from a real gesture, on a subscription bound to an authenticated
 * user row. It is the only true read receipt in this system, and
 * channel-liveness reads it.
 *
 * NO SESSION, deliberately. Authentication is possession of the push endpoint
 * (a capability URL the push service minted and only this browser and we
 * hold) plus, for the read-marking half, the notification's own uuid. That is
 * strictly stronger than the existing precedent in dispatch.ts, where an
 * unsubscribe link authenticates on a single business uuid. Requiring a
 * session would mean a receipt silently stops recording for any owner who has
 * not signed in lately, which is precisely the owner this check exists to
 * notice.
 *
 * CSRF needs no exemption: a service-worker POST is same-origin and carries
 * our own Origin header, which is what src/proxy.ts checks.
 */

import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { listLivePushSubscriptions, recordPushClick } from "@/lib/push/db";
import { markNotificationRead, notificationBusinessId } from "@/lib/db/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  endpoint: z.string().min(1).max(2048),
  notificationId: z.string().uuid().optional()
});

const RECEIPT_RATE = { interval: 60 * 1000, maxRequests: 30 };

export async function POST(request: Request): Promise<Response> {
  try {
    const body = bodySchema.parse(await request.json());

    const limiter = rateLimit(`push-receipt:${body.endpoint}`, RECEIPT_RATE);
    if (!limiter.success) {
      return errorResponse("VALIDATION_ERROR", "Too many receipts", 429);
    }

    const subscriptions = await listLivePushSubscriptions(body.endpoint);
    // An unknown or revoked endpoint records nothing and is not an error: the
    // tap is real but we have no scope to attribute it to, and a 4xx here
    // would only produce noise in a service worker that cannot act on it.
    if (subscriptions.length === 0) return successResponse({ recorded: false });

    /**
     * WHICH SCOPE DID THIS TAP BELONG TO?
     *
     * Usually there is one answer. But a person who is both a business owner
     * and an HQ admin, subscribed in the same browser, holds a tenant row AND
     * a platform row on the SAME endpoint, so the endpoint alone cannot say.
     * Picking arbitrarily would either drop the receipt (platform row wins) or
     * file a platform alert as that tenant's liveness evidence (tenant row
     * wins), and manufacturing liveness is the exact failure this whole check
     * exists to prevent.
     *
     * The notification knows, so it is asked. Without one, only an
     * unambiguous single scope is trusted.
     */
    const scopes = [...new Set(subscriptions.map((s) => s.business_id))];
    let businessId: string | null = null;
    if (body.notificationId) {
      const owner = await notificationBusinessId(body.notificationId);
      // Must be a scope this device is actually subscribed under, so a known
      // endpoint cannot be used to stamp a click on an unrelated tenant.
      businessId = owner && scopes.includes(owner) ? owner : null;
    } else if (scopes.length === 1) {
      businessId = scopes[0];
    }

    // The platform scope (HQ admin) has no business_id, and
    // notification_link_clicks is business-scoped by design. An admin tap is
    // not a tenant's liveness evidence, so there is nothing to record. The
    // same is true of an ambiguous tap we could not attribute.
    if (businessId === null) return successResponse({ recorded: false });

    await recordPushClick({ businessId, notificationId: body.notificationId });

    if (body.notificationId) {
      // Marking it read is correct and separate from the liveness signal
      // above: the owner has genuinely seen this alert, so it should stop
      // showing as unread.
      try {
        await markNotificationRead(body.notificationId, businessId, "owner");
      } catch (err) {
        // The receipt is the valuable half and it already landed. A failure
        // to clear the unread badge must not discard it.
        logger.warn("push receipt: mark-read failed", {
          businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return successResponse({ recorded: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
