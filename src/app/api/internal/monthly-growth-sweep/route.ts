/**
 * Internal, cron-triggered monthly growth-recap sweep.
 *
 * Call chain: pg_cron → Edge `monthly-growth-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Emails each owner once a month, after the 3rd, about the month that ended:
 * leads captured, texts sent, calls answered, minutes on the phone, each
 * beside the previous month, with a hedged projection when there is enough
 * history to draw one.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { sweepMonthlyGrowthEmails } from "@/lib/analytics/monthly-growth-sweep";

// 150 matches the chain's reachable budget: Supabase 504s the Edge bridge at
// 150s. This sweep is heavier than the nudge sweeps (one snapshot read plus
// one contact count per month, per tenant), but it is bounded by
// GROWTH_EMAIL_BATCH_LIMIT and only does real work on three days out of
// thirty.
export const maxDuration = 150;
export const runtime = "nodejs";

async function runSweep(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const result = await sweepMonthlyGrowthEmails();
    const durationMs = Date.now() - startedAt;
    logger.info("monthly-growth-sweep: summary", { ...result, durationMs });
    // `sweep` self-identifies this response for debug/cron-http-stats.ts,
    // whose grouping is shape-based and would otherwise blend this with the
    // other monthly email sweeps.
    return successResponse({ ...result, durationMs, sweep: "monthly-growth-sweep" });
  } catch (err) {
    logger.error("monthly-growth-sweep: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Sweep failed", 500);
  }
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("monthly-growth-sweep", runSweep);
