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
import { logger } from "@/lib/logger";
import { runSnapshotSweep } from "@/lib/analytics/snapshots";

// Fleet-wide sweep with residency-routed transcript reads — same ceiling as
// the other sweeps.
export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
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
