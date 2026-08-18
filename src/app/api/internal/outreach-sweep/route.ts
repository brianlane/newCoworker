/**
 * Internal, cron-triggered Prospecting sweep.
 *
 * Call chain: pg_cron → Edge `outreach-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Discovers, drafts, sends, and follows up for every business with
 * Prospecting switched on, see src/lib/outreach/sweep.ts.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { processOutreachSweep } from "@/lib/outreach/sweep";

// 150 matches the chain's reachable budget: Supabase 504s the Edge bridge
// at 150s, and this sweep's worst run in the ledger's first full week was
// 17.0s (cron_sweep_runs, 2026-08-15). Declaring more only granted unused
// background time after the 504.
export const maxDuration = 150;
export const runtime = "nodejs";

async function runSweep(request: Request): Promise<Response> {
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

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("outreach-sweep", runSweep);
