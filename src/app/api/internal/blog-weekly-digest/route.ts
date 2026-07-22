/**
 * Internal, cron-triggered weekly PR-digest post.
 *
 * Call chain: pg_cron (Mondays) → Edge `blog-weekly-digest` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Summarizes the prior week's merged feature PRs into a scheduled blog
 * post — see src/lib/blog/weekly-digest.ts for the volume bar, the
 * features-only filter, and the word cap.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { runWeeklyDigest } from "@/lib/blog/weekly-digest";

export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const result = await runWeeklyDigest();
    logger.info("blog-weekly-digest: summary", { ...result, durationMs: Date.now() - startedAt });
    return successResponse(result);
  } catch (err) {
    logger.error("blog-weekly-digest: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Digest run failed", 500);
  }
}
