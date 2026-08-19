/**
 * Internal, cron-triggered analytics snapshot sweep.
 *
 * Call chain: pg_cron → Edge `analytics-snapshot-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Recomputes + upserts the last few finished UTC days of
 * `analytics_daily_snapshots` for every business (see
 * src/lib/analytics/snapshots.ts). Per-tenant errors are captured and the
 * sweep continues; every write is idempotent so tomorrow's run converges.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { runSnapshotSweep } from "@/lib/analytics/snapshots";

// Fleet-wide sweep with residency-routed transcript reads, same ceiling as
// the other sweeps.
// 150 matches the chain's reachable budget: Supabase 504s the Edge bridge
// at 150s, and this sweep's worst run in the ledger's first full week was
// 3.5s (cron_sweep_runs, 2026-08-15). Declaring more only granted unused
// background time after the 504.
export const maxDuration = 150;
export const runtime = "nodejs";

async function runSweep(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const result = await runSnapshotSweep();
    const durationMs = Date.now() - startedAt;
    logger.info("analytics-snapshot-sweep: summary", { ...result, durationMs });
    return successResponse({ ...result, durationMs });
  } catch (err) {
    logger.error("analytics-snapshot-sweep: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Snapshot sweep failed", 500);
  }
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("analytics-snapshot-sweep", runSweep);
