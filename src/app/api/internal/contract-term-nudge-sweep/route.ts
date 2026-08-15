/**
 * Internal, cron-triggered pre-term contract rollover nudge sweep.
 *
 * Call chain: pg_cron → Edge `contract-term-nudge-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Emails each eligible annual/biennial subscriber (auto-renew off) once,
 * 5 business days before term end (Shape B soft notice).
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { sweepContractTermNudges } from "@/lib/billing/contract-term-nudge";

// 150 matches the chain's reachable budget: Supabase 504s the Edge bridge
// at 150s, and this sweep's worst run in the ledger's first full week was
// 0.1s (cron_sweep_runs, 2026-08-15). Declaring more only granted unused
// background time after the 504.
export const maxDuration = 150;
export const runtime = "nodejs";

async function runSweep(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const result = await sweepContractTermNudges();
    const durationMs = Date.now() - startedAt;
    logger.info("contract-term-nudge-sweep: summary", { ...result, durationMs });
    // `sweep` self-identifies this response for debug/cron-http-stats.ts:
    // the other nudge sweep returns the identical key set, and the stats
    // tool's shape-based grouping would blend the two without it.
    return successResponse({ ...result, durationMs, sweep: "contract-term-nudge-sweep" });
  } catch (err) {
    logger.error("contract-term-nudge-sweep: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Sweep failed", 500);
  }
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("contract-term-nudge-sweep", runSweep);
