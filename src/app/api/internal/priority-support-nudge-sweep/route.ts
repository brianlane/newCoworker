/**
 * Internal, cron-triggered priority support expiry nudge sweep.
 *
 * Call chain: pg_cron to Edge `priority-support-nudge-sweep` to this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Emails each tenant whose priority support window is about to lapse once,
 * 5 business days out. Renewing subscriptions are never warned: their window
 * moves forward on every paid invoice.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { sweepPrioritySupportNudges } from "@/lib/billing/priority-support-nudge";

// 150 matches the chain's reachable budget: Supabase 504s the Edge bridge at
// 150s, so declaring more only grants unused background time after the 504.
// Same ceiling the other two nudge sweeps run at.
export const maxDuration = 150;
export const runtime = "nodejs";

async function runSweep(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const result = await sweepPrioritySupportNudges();
    const durationMs = Date.now() - startedAt;
    logger.info("priority-support-nudge-sweep: summary", { ...result, durationMs });
    // `sweep` self-identifies this response for debug/cron-http-stats.ts: the
    // other nudge sweeps return the identical key set, and the stats tool's
    // shape-based grouping would blend them without it.
    return successResponse({ ...result, durationMs, sweep: "priority-support-nudge-sweep" });
  } catch (err) {
    logger.error("priority-support-nudge-sweep: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Sweep failed", 500);
  }
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("priority-support-nudge-sweep", runSweep);
