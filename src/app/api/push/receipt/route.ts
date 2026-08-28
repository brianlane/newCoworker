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
import { findLivePushSubscription, recordPushClick } from "@/lib/push/db";
import { markNotificationRead } from "@/lib/db/notifications";

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

    const subscription = await findLivePushSubscription(body.endpoint);
    // An unknown or revoked endpoint records nothing and is not an error: the
    // tap is real but we have no scope to attribute it to, and a 4xx here
    // would only produce noise in a service worker that cannot act on it.
    if (!subscription) return successResponse({ recorded: false });

    // The platform scope (HQ admin) has no business_id, and
    // notification_link_clicks is business-scoped by design. An admin tap is
    // not a tenant's liveness evidence, so there is nothing to record.
    if (subscription.business_id !== null) {
      await recordPushClick({
        businessId: subscription.business_id,
        notificationId: body.notificationId
      });

      if (body.notificationId) {
        // Marking it read is correct and separate from the liveness signal
        // above: the owner has genuinely seen this alert, so it should stop
        // showing as unread. markNotificationRead scopes by business_id, so a
        // notification id from another tenant matches zero rows.
        try {
          await markNotificationRead(body.notificationId, subscription.business_id, "owner");
        } catch (err) {
          // The receipt is the valuable half and it already landed. A failure
          // to clear the unread badge must not discard it.
          logger.warn("push receipt: mark-read failed", {
            businessId: subscription.business_id,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    return successResponse({ recorded: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
