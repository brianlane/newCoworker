/**
 * Internal Slack reply worker endpoint.
 *
 * Call chain: Slack webhook route (fire-and-forget kick on enqueue) AND
 * pg_cron → Edge `slack-jobs-sweep` → this route (per-minute retry net).
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Drains a bounded batch of queued reply jobs via processSlackJobs
 * (claim → tier gate → identity → inline turn → streamed post → atomic
 * commit). Mirrors /api/internal/messenger-worker.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { processSlackJobs } from "@/lib/slack/worker";
import { logger } from "@/lib/logger";

// Each turn budgets 60s of inline engine plus Slack posts; a full batch of
// 8 needs real headroom.
export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function runSweep(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  const summary = await processSlackJobs();
  const durationMs = Date.now() - startedAt;

  if (summary.processed > 0 || summary.reclaimed > 0 || summary.failed > 0) {
    logger.info("slack-worker: summary", { ...summary, durationMs });
  }
  return successResponse({ ...summary, durationMs });
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("slack-worker", runSweep);
