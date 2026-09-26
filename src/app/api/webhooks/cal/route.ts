/**
 * POST /api/webhooks/cal?business=<uuid>&token=<verification-token>
 *
 * Cal.com booking events. The URL token drops unsigned junk. The HMAC
 * over the raw body is the real authentication.
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/api-response";
import { getCalConnectionByBusiness } from "@/lib/db/cal-connections";
import { verificationTokenMatches } from "@/lib/integrations/webhook-token";
import { CAL_SIGNATURE_HEADER } from "@/lib/cal/client";
import { processCalWebhook } from "@/lib/cal/webhook";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const businessIdSchema = z.string().uuid();

export async function POST(request: Request) {
  const url = new URL(request.url);
  const business = businessIdSchema.safeParse(url.searchParams.get("business"));
  const token = url.searchParams.get("token") ?? "";
  if (!business.success || token.length === 0) {
    return errorResponse("UNAUTHORIZED", "Missing business or token");
  }
  const conn = await getCalConnectionByBusiness(business.data);
  if (!conn || !verificationTokenMatches(token, conn.webhook_verification_token)) {
    return errorResponse("UNAUTHORIZED", "Invalid webhook credentials");
  }
  const rawBody = await request.text();
  const result = await processCalWebhook(
    business.data,
    rawBody,
    request.headers.get(CAL_SIGNATURE_HEADER),
    conn.webhookSecret
  );
  if (!result.ok) {
    logger.warn("cal webhook rejected", { businessId: business.data, reason: result.reason });
    return errorResponse("UNAUTHORIZED", "Invalid webhook signature");
  }
  return successResponse({ ok: true, ignored: result.ignored ?? null });
}
