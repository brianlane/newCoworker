/**
 * Internal, cron-triggered email-campaign sender.
 *
 * Call chain: pg_cron → Edge `email-campaign-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Promotes due scheduled campaigns (snapshotting their audiences) and
 * drains each sending campaign's pending recipients in bounded batches,
 * see src/lib/campaigns/send.ts.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { processCampaignSweep } from "@/lib/campaigns/send";

// 150 matches the chain's reachable budget: Supabase 504s the Edge bridge
// at 150s, and this sweep's worst run in the ledger's first full week was
// 9.0s (cron_sweep_runs, 2026-08-15). Declaring more only granted unused
// background time after the 504.
export const maxDuration = 150;
export const runtime = "nodejs";

async function runSweep(request: Request): Promise<Response> {
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

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("email-campaign-sweep", runSweep);
