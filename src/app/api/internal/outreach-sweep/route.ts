/**
 * Internal, cron-triggered Prospecting sweep.
 *
 * Call chain: pg_cron → Edge `outreach-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Discovers, drafts, sends, and follows up for every business with
 * Prospecting switched on — see src/lib/outreach/sweep.ts.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { processOutreachSweep } from "@/lib/outreach/sweep";

export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const result = await processOutreachSweep();
    const durationMs = Date.now() - startedAt;
    // Quiet minutes (every business outside its window, nothing to draft) stay
    // unlogged; notes alone are not news.
    if (result.discovered || result.drafted || result.sent || result.nudged || result.errors.length) {
      logger.info("outreach-sweep: summary", { ...result, durationMs });
    }
    return successResponse({ ...result, durationMs });
  } catch (err) {
    logger.error("outreach-sweep: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Sweep failed", 500);
  }
}
