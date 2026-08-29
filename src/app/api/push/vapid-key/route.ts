/**
 * The VAPID public key browsers need for
 * `pushManager.subscribe({ applicationServerKey })`.
 *
 * Unauthenticated on purpose: this key is handed to every browser that
 * subscribes, so it is public by definition, and requiring a session would
 * add a 401 round trip inside a gesture-sensitive flow for no benefit.
 *
 * Served from a route rather than baked in as NEXT_PUBLIC_VAPID_PUBLIC_KEY so
 * that the public and private halves can never skew across a rotation. See
 * the header of src/lib/push/keys.ts for what that failure looks like.
 *
 * 503 rather than an empty 200 when unconfigured: a preview deployment
 * missing the env pair should say so, not mint subscriptions that can never
 * be delivered to.
 */

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { publicVapidKey } from "@/lib/push/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const publicKey = publicVapidKey();
    if (!publicKey) {
      return errorResponse("INTERNAL_SERVER_ERROR", "Push is not configured", 503);
    }
    const response = successResponse({ publicKey });
    // Short cache: long enough to spare the repeat fetch on every dashboard
    // load, short enough that a key rotation converges without a redeploy.
    response.headers.set("Cache-Control", "public, max-age=300");
    return response;
  } catch (err) {
    return handleRouteError(err);
  }
}
