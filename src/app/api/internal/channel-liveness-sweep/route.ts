/**
 * Internal, cron-triggered channel-liveness sweep.
 *
 * Call chain: pg_cron → Edge `channel-liveness-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Asks, per tenant, whether a HUMAN is still on the other end of each alert
 * channel we send on, and writes one admin `system_logs` row for every
 * tenant that has gone dark or degraded. The judgement is pure and lives in
 * `src/lib/notifications/channel-liveness.ts`; the reads live in
 * `channel-liveness-sweep.ts` beside it.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { sweepChannelLiveness } from "@/lib/notifications/channel-liveness-sweep";

// 150 is the whole chain's reachable budget: Supabase 504s the Edge bridge
// at 150s regardless of what the layers above declare. The work is a handful
// of indexed reads per tenant over a fleet of eleven, so the real cost is
// nowhere near it.
export const maxDuration = 150;
export const runtime = "nodejs";

async function runSweep(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const result = await sweepChannelLiveness();
    const durationMs = Date.now() - startedAt;
    logger.info("channel-liveness-sweep: summary", { ...result, durationMs });
    // `sweep` self-identifies this response for debug/cron-http-stats.ts,
    // whose grouping is shape-based and would otherwise blend sweeps that
    // happen to return the same key set.
    return successResponse({ ...result, durationMs, sweep: "channel-liveness-sweep" });
  } catch (err) {
    logger.error("channel-liveness-sweep: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Sweep failed", 500);
  }
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("channel-liveness-sweep", runSweep);
