/**
 * POST /api/webhooks/zoom, the Marketplace app's event notification
 * endpoint (event subscription added Jul 2026: recording.transcript_completed
 * + app_deauthorized).
 *
 * Every delivery is authenticated by the x-zm-signature HMAC (keyed by the
 * app's Secret Token, env ZOOM_SECRET_TOKEN) with a 5-minute timestamp
 * window; the endpoint.url_validation challenge is answered in Zoom's exact
 * shape (unwrapped JSON). Transcript auto-imports run inline, fetch +
 * Gemini condense fit the same budget as the owner-attended manual import.
 * Only a transient import failure answers 5xx (so Zoom redelivers); every
 * skip outcome is a 200 no-op.
 */
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  processZoomWebhookEvent,
  verifyZoomWebhookSignature,
  ZOOM_WEBHOOK_MAX_BODY_BYTES
} from "@/lib/zoom/webhook";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
// Transcript fetch + Gemini condense run inline (same as the manual import).
export const maxDuration = 120;

// One shared Marketplace app: deliveries for the whole fleet land here.
// 600/min absorbs busy days and Zoom's retry bursts while capping abuse.
const ZOOM_WEBHOOK_RATE = { interval: 60 * 1000, maxRequests: 600 };

export async function POST(request: Request) {
  try {
    const limiter = rateLimit("zoom-webhook", ZOOM_WEBHOOK_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Rate limit exceeded, retry shortly.", 429);
    }

    const text = await request.text();
    if (text.length > ZOOM_WEBHOOK_MAX_BODY_BYTES) {
      return errorResponse("VALIDATION_ERROR", "payload too large", 413);
    }

    const verified = verifyZoomWebhookSignature(
      text,
      request.headers.get("x-zm-request-timestamp"),
      request.headers.get("x-zm-signature")
    );
    if (!verified) {
      return errorResponse("UNAUTHORIZED", "Invalid webhook signature");
    }

    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      return errorResponse("VALIDATION_ERROR", "body must be JSON");
    }

    const result = await processZoomWebhookEvent(json);

    if (result.kind === "url_validation") {
      if (!result.response) {
        return errorResponse("INTERNAL_SERVER_ERROR", "Webhook secret not configured", 500);
      }
      // Zoom expects the bare challenge shape, not our response envelope.
      return new Response(JSON.stringify(result.response), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (result.kind === "transcript" && result.outcome === "import_failed") {
      // Non-2xx makes Zoom redeliver; the ledger claim was released.
      return errorResponse("INTERNAL_SERVER_ERROR", "transcript import failed", 500);
    }

    return successResponse(result);
  } catch (err) {
    logger.warn("zoom webhook failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return handleRouteError(err);
  }
}
