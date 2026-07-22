/**
 * Internal, cron-triggered weekly PR-digest post.
 *
 * Call chain: pg_cron (Mondays) → Edge `blog-weekly-digest` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * One auto post per week on a rotating category — PR digest, Tutorial,
 * Business Tips, Feature deep-dive — see src/lib/blog/weekly-topics.ts
 * (rotation + fallbacks) and src/lib/blog/weekly-digest.ts (the digest's
 * volume bar, features-only filter, and word cap).
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { runWeeklyAuto } from "@/lib/blog/weekly-topics";

export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const result = await runWeeklyAuto();
    logger.info("blog-weekly-digest: summary", { ...result, durationMs: Date.now() - startedAt });
    return successResponse(result);
  } catch (err) {
    logger.error("blog-weekly-digest: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Digest run failed", 500);
  }
}
