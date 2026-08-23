/**
 * Internal, cron-triggered abandoned-signup cleanup.
 *
 * Call chain: pg_cron → Edge `abandoned-signup-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Deletes the `businesses` rows left behind by onboarding sessions that
 * reached Stripe Checkout and never paid. The Stripe webhook has referred to
 * this job as the "abandoned-subs cleanup" since before it existed (see
 * src/app/api/webhooks/stripe/route.ts, where both payment-failure handlers
 * deliberately leave the subscription at `pending` for it to prune).
 *
 * Every guard that decides what is safe to delete lives in the lib module,
 * under test at 100% coverage. This route only wires it up.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { sweepAbandonedSignups } from "@/lib/onboarding/abandoned-signup-cleanup";

// 150 matches the chain's reachable budget: Supabase 504s the Edge bridge at
// 150s. This sweep does one list query plus a handful of count queries per
// abandoned cart, and the batch cap bounds the delete count per run.
export const maxDuration = 150;
export const runtime = "nodejs";

async function runSweep(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const result = await sweepAbandonedSignups();
    const durationMs = Date.now() - startedAt;
    logger.info("abandoned-signup-sweep: summary", {
      scanned: result.scanned,
      deleted: result.deleted.length,
      skipped: result.skipped.length,
      errors: result.errors.length,
      cappedAtLimit: result.cappedAtLimit,
      durationMs
    });
    // `sweep` self-identifies this response for debug/cron-http-stats.ts.
    return successResponse({ ...result, durationMs, sweep: "abandoned-signup-sweep" });
  } catch (err) {
    logger.error("abandoned-signup-sweep: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Sweep failed", 500);
  }
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("abandoned-signup-sweep", runSweep);
