/**
 * Internal coworker reply worker endpoint, for every channel at once.
 *
 * Call chain: a channel's webhook route (fire-and-forget kick on enqueue)
 * AND pg_cron → Edge `coworker-jobs-sweep` → this route (per-minute retry
 * net). Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Drains a bounded batch of queued reply jobs from the shared queue,
 * handing each one to its channel's adapter. Replaces
 * /api/internal/slack-worker: one queue means one route, one edge function
 * and one cron entry no matter how many channels are connected, and the
 * claim RPC orders by age across all of them, so a busy workspace on one
 * channel cannot starve a thread on another.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { processCoworkerJobs } from "@/lib/coworker-channels/worker";
import { logger } from "@/lib/logger";

// Each turn budgets 60s of inline engine plus the provider posts; a full
// batch of 8 needs real headroom.
export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function runSweep(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  const summary = await processCoworkerJobs();
  const durationMs = Date.now() - startedAt;

  if (summary.processed > 0 || summary.reclaimed > 0 || summary.failed > 0) {
    logger.info("coworker-worker: summary", { ...summary, durationMs });
  }
  return successResponse({ ...summary, durationMs });
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("coworker-worker", runSweep);
