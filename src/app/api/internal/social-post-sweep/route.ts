/**
 * Internal, cron-triggered Instagram post publisher.
 *
 * Call chain: pg_cron → Edge `social-post-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Promotes due scheduled posts and publishes them through the Instagram
 * Graph API — see src/lib/social/publish.ts.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { processSocialPostSweep } from "@/lib/social/publish";

export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const result = await processSocialPostSweep();
    const durationMs = Date.now() - startedAt;
    // Quiet minutes (nothing due, nothing stuck) stay unlogged.
    if (result.promoted || result.published || result.failed || result.staled || result.errors.length) {
      logger.info("social-post-sweep: summary", { ...result, durationMs });
    }
    return successResponse({ ...result, durationMs });
  } catch (err) {
    logger.error("social-post-sweep: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Sweep failed", 500);
  }
}
