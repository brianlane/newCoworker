/**
 * POST /api/webhooks/acuity?business=<uuid>&token=<verification-token>
 *
 * Acuity → platform webhook receiver. Registered automatically at connect
 * time when Acuity's Webhooks API allows it, otherwise the owner pastes this
 * URL from the dashboard card.
 *
 * TWO layers of authentication, and only one of them is the real one:
 *
 *   - The URL token is defense in depth, so unsigned junk never reaches the
 *     signature check or the body parse.
 *   - The HMAC over the RAW body, keyed by the account's API key, is the
 *     actual authentication.
 *
 * The raw body is read FIRST, before anything else touches the request.
 * Acuity signs the exact bytes it sent, and re-serializing a parsed form does
 * not reproduce them (key order and percent-encoding both differ), so a
 * `request.formData()` call before this point would silently break every
 * signature.
 *
 * Response discipline matters more here than for most receivers: Acuity
 * retries 5xx with backoff for 24 hours and DISABLES the webhook after five
 * days of continuous failure. So anything we understand, including deliveries
 * we deliberately ignore, answers 2xx. The single exception is a failure to
 * read the appointment back from Acuity, which is genuinely transient and
 * genuinely worth retrying. The ~1/min poller keeps triggers correct
 * throughout regardless, which is what makes that discipline safe.
 */
import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { getAcuityConnection } from "@/lib/db/acuity-connections";
import { verifyAcuityWebhookSignature, ACUITY_SIGNATURE_HEADER } from "@/lib/acuity/client";
import { verificationTokenMatches } from "@/lib/integrations/webhook-token";
import {
  ACUITY_WEBHOOK_MAX_BODY_BYTES,
  AcuityHydrationError,
  parseAcuityWebhookBody,
  processAcuityWebhookEvent
} from "@/lib/acuity/webhook";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** Absorbs Acuity's retry bursts while capping a misconfigured loop. */
const ACUITY_WEBHOOK_RATE = { interval: 60 * 1000, maxRequests: 240 };

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

    const limiter = rateLimit(`acuity-webhook:${businessId}`, ACUITY_WEBHOOK_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Rate limit exceeded, retry shortly.", 429);
    }

    // The full row, not the id-only probe: the API key IS the HMAC secret.
    const conn = await getAcuityConnection(businessId);
    if (!conn || !conn.is_active || !verificationTokenMatches(token, conn.webhook_verification_token)) {
      return errorResponse("UNAUTHORIZED", "Invalid webhook credentials");
    }

    // Read the raw body BEFORE anything else consumes the stream.
    const rawBody = await request.text();
    if (rawBody.length > ACUITY_WEBHOOK_MAX_BODY_BYTES) {
      return errorResponse("VALIDATION_ERROR", "Payload too large");
    }

    const signature = request.headers.get(ACUITY_SIGNATURE_HEADER);
    if (!verifyAcuityWebhookSignature(rawBody, signature, conn.apiKey)) {
      return errorResponse("UNAUTHORIZED", "Invalid signature");
    }

    const event = parseAcuityWebhookBody(rawBody);
    if (!event) {
      // Understood and deliberately ignored. A 4xx or 5xx here would count
      // toward Acuity's five-day disable window for no reason.
      return successResponse({ ignored: true });
    }

    try {
      const result = await processAcuityWebhookEvent(businessId, conn, event);
      return successResponse(result);
    } catch (err) {
      if (err instanceof AcuityHydrationError) {
        // The ONE retryable case: the payload is ids only, so without the
        // appointment there is nothing to act on, and Acuity may well serve
        // it a moment later.
        logger.warn("acuity webhook: hydration failed, asking Acuity to retry", {
          businessId,
          appointmentId: event.appointmentId,
          error: err.message
        });
        return errorResponse("INTERNAL_SERVER_ERROR", "Could not read the appointment", 500);
      }
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
