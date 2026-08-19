/**
 * Internal, cron-triggered blog publisher.
 *
 * Call chain: pg_cron → Edge `blog-publish-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Promotes due scheduled posts to published and fans out the side effects
 * (subscriber email + Instagram cross-post), see src/lib/blog/publish.ts.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { processBlogPublishSweep } from "@/lib/blog/publish";

// 150 matches the chain's reachable budget: Supabase 504s the Edge bridge
// at 150s, and this sweep's worst run in the ledger's first full week was
// 3.4s (cron_sweep_runs, 2026-08-15). Declaring more only granted unused
// background time after the 504.
export const maxDuration = 150;
export const runtime = "nodejs";

async function runSweep(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const result = await processBlogPublishSweep();
    const durationMs = Date.now() - startedAt;
    // Quiet passes (nothing due) stay unlogged.
    if (result.published || result.emailErrors || result.errors.length) {
      logger.info("blog-publish-sweep: summary", { ...result, durationMs });
    }
    return successResponse({ ...result, durationMs });
  } catch (err) {
    logger.error("blog-publish-sweep: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Sweep failed", 500);
  }
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("blog-publish-sweep", runSweep);
