/**
 * Internal Messenger reply worker endpoint.
 *
 * Call chain: Meta webhook route (fire-and-forget kick on enqueue) AND
 * pg_cron → Edge `messenger-jobs-sweep` → this route (per-minute retry
 * net). Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Drains a bounded batch of queued reply jobs via processMessengerJobs
 * (claim → 24h-window gate → Gemini turn → Send API → atomic commit).
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { processMessengerJobs } from "@/lib/messenger/worker";
import { logger } from "@/lib/logger";

// Each turn budgets 30s of Gemini plus a Send API call; a full batch of 8
// needs real headroom.
export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  const summary = await processMessengerJobs();
  const durationMs = Date.now() - startedAt;

  if (summary.claimed > 0 || summary.requeued > 0) {
    logger.info("messenger-worker: summary", { ...summary, durationMs });
  }
  return successResponse({ ...summary, durationMs });
}
