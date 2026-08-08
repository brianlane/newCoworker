/**
 * Internal, cron-triggered residency journal replay.
 *
 * Call chain: pg_cron → Edge fn `residency-replay` → this route (same
 * bridge pattern as subscription-grace-sweep). Bearer:
 * `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Drains residency_write_journal to each opted-in enterprise tenant's
 * box-local data API in strict seq order per business; a down box stops
 * only its own queue and the next tick resumes. See
 * src/lib/residency/replay.ts for the worst-case posture.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { runResidencyReplay } from "@/lib/residency/replay";

// Bounded by perBusinessLimit/businessLimit inside the replayer (each batch is
// one HTTP call to a box with a 10s client timeout), so this is a safety net,
// not an expected runtime.
//
// It is 50, not the 300s Vercel Pro ceiling, to match the job's pg_cron
// timeout_milliseconds := 50000 (20260804000000_residency_write_journal.sql).
// The job runs every minute and the replayer takes no claim or advisory lock
// while draining strictly in `seq` order per business, so the sub-cadence
// budget is what keeps two replays off the same journal rows. Raising this
// (or the cron timeout) to 300 would let up to five runs overlap and apply a
// tenant's journal twice or out of order. A run cut short here is safe by
// design: the next tick resumes from the same seq.
//
// tests/cron-timeout-parity.test.ts pins maxDuration * 1000 <= the cron
// timeout, so the two numbers cannot drift apart again.
export const maxDuration = 50;

export const runtime = "nodejs";

async function runSweep(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  try {
    const summary = await runResidencyReplay();
    if (summary.totalReplayed > 0 || summary.totalErrors > 0 || summary.totalSkipped > 0) {
      logger.info("residency-replay: summary", {
        replayed: summary.totalReplayed,
        skipped: summary.totalSkipped,
        errors: summary.totalErrors,
        businesses: summary.businesses.length
      });
    }
    return successResponse(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("residency-replay: run failed", { error: message });
    return errorResponse("INTERNAL_SERVER_ERROR", message, 500);
  }
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("residency-replay", runSweep);
