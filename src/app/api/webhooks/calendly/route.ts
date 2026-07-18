/**
 * POST /api/webhooks/calendly?business=<uuid>
 *
 * Calendly invitee.created receiver — the real-time fast path for
 * appointment_booked goal events (the ~1/min booking-goal sweep remains the
 * always-on fallback). Subscriptions are created lazily by the sweep
 * (src/lib/calendly/webhook-subscriptions.ts) for businesses whose Calendly
 * plan supports webhooks.
 *
 * Auth is the per-subscription signing key: every delivery must carry a
 * valid `Calendly-Webhook-Signature` (HMAC-SHA256 over `t.rawBody`,
 * timing-safe compare, 5-minute replay bound). The business id in the URL
 * only selects WHICH signing key to verify against — a forged id fails the
 * signature check.
 */
import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getCalendlyWebhookSubscription } from "@/lib/db/calendly-webhook-subscriptions";
import {
  CALENDLY_WEBHOOK_MAX_BODY_BYTES,
  CALENDLY_WEBHOOK_SIGNATURE_HEADER,
  handleCalendlyWebhookEvent,
  verifyCalendlyWebhookSignature
} from "@/lib/calendly/webhook-inbound";

export const dynamic = "force-dynamic";

// Deliveries are per-booking (low volume); 240/min absorbs Calendly's retry
// bursts while capping a misconfigured loop.
const CALENDLY_WEBHOOK_RATE = { interval: 60 * 1000, maxRequests: 240 };

const businessIdSchema = z.string().uuid();

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const business = businessIdSchema.safeParse(url.searchParams.get("business"));
    if (!business.success) {
      return errorResponse("UNAUTHORIZED", "Missing business");
    }
    const businessId = business.data;

    const limiter = rateLimit(`calendly-webhook:${businessId}`, CALENDLY_WEBHOOK_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Rate limit exceeded, retry shortly.", 429);
    }

    const rawBody = await request.text();
    if (rawBody.length > CALENDLY_WEBHOOK_MAX_BODY_BYTES) {
      return errorResponse("VALIDATION_ERROR", "payload too large (64KB max)", 413);
    }

    const db = await createSupabaseServiceClient();
    const sub = await getCalendlyWebhookSubscription(businessId, db);
    if (!sub || sub.status !== "active" || !sub.signingKey) {
      return errorResponse("UNAUTHORIZED", "No active webhook subscription");
    }
    if (
      !verifyCalendlyWebhookSignature(
        rawBody,
        request.headers.get(CALENDLY_WEBHOOK_SIGNATURE_HEADER),
        sub.signingKey,
        Date.now()
      )
    ) {
      return errorResponse("UNAUTHORIZED", "Invalid webhook signature");
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return errorResponse("VALIDATION_ERROR", "body must be JSON");
    }

    const result = await handleCalendlyWebhookEvent(db, businessId, json, sub);
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
