/**
 * POST /api/webhooks/vagaro?business=<uuid>&token=<verification-token>
 *
 * Direct Vagaro → platform webhook receiver (no Zapier hop). The owner
 * pastes this tenant-specific URL — surfaced on the dashboard's Vagaro card
 * — into Vagaro's APIs & Webhooks settings. Auth is possession of the URL:
 * the embedded token is compared timing-safe against the connection row
 * (same model as Vagaro's own "endpoint URL + verification token" setup).
 *
 * Each delivery starts matching webhook-triggered AiFlows (source "vagaro",
 * idempotent per Vagaro event id) and syncs customer events into contacts —
 * see src/lib/vagaro/webhook.ts. Always answers 200 on success within
 * Vagaro's 20-second window; non-2xx makes Vagaro retry (up to 5 times over
 * 15 minutes), which the event-id dedupe absorbs.
 */
import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { getVagaroConnection } from "@/lib/db/vagaro-connections";
import {
  parseVagaroWebhookBody,
  processVagaroWebhookEvent,
  VAGARO_WEBHOOK_MAX_BODY_BYTES,
  verificationTokenMatches
} from "@/lib/vagaro/webhook";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// Vagaro's per-event webhooks are low volume; 240/min absorbs its retry
// bursts while capping a misconfigured loop.
const VAGARO_WEBHOOK_RATE = { interval: 60 * 1000, maxRequests: 240 };

const businessIdSchema = z.string().uuid();

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const business = businessIdSchema.safeParse(url.searchParams.get("business"));
    const token = url.searchParams.get("token") ?? "";
    if (!business.success || token.length === 0) {
      return errorResponse("UNAUTHORIZED", "Missing business or token");
    }
    const businessId = business.data;

    const limiter = rateLimit(`vagaro-webhook:${businessId}`, VAGARO_WEBHOOK_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Rate limit exceeded, retry shortly.", 429);
    }

    const conn = await getVagaroConnection(businessId);
    if (
      !conn ||
      !conn.is_active ||
      !verificationTokenMatches(token, conn.webhook_verification_token)
    ) {
      return errorResponse("UNAUTHORIZED", "Invalid webhook token");
    }

    const text = await request.text();
    if (text.length > VAGARO_WEBHOOK_MAX_BODY_BYTES) {
      return errorResponse("VALIDATION_ERROR", "payload too large (64KB max)", 413);
    }
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      return errorResponse("VALIDATION_ERROR", "body must be JSON");
    }
    const event = parseVagaroWebhookBody(json);
    if (!event) {
      return errorResponse("VALIDATION_ERROR", "empty event body");
    }

    const result = await processVagaroWebhookEvent(businessId, event);
    return successResponse(result);
  } catch (err) {
    logger.warn("vagaro webhook failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return handleRouteError(err);
  }
}
