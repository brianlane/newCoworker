/**
 * Internal, cron-triggered email-campaign sender.
 *
 * Call chain: pg_cron → Edge `email-campaign-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Promotes due scheduled campaigns (snapshotting their audiences) and
 * drains each sending campaign's pending recipients in bounded batches —
 * see src/lib/campaigns/send.ts.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { processCampaignSweep } from "@/lib/campaigns/send";

export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const result = await processCampaignSweep();
    const durationMs = Date.now() - startedAt;
    // Quiet minutes (nothing due, nothing sending) stay unlogged.
    if (result.promoted || result.sent || result.failed || result.completed || result.errors.length) {
      logger.info("email-campaign-sweep: summary", { ...result, durationMs });
    }
    return successResponse({ ...result, durationMs });
  } catch (err) {
    logger.error("email-campaign-sweep: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Sweep failed", 500);
  }
}
