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
import { logger } from "@/lib/logger";
import { runResidencyReplay } from "@/lib/residency/replay";

// Bounded by perBusinessLimit/businessLimit inside the replayer; 300s is the
// Vercel Pro ceiling and a pure safety net (each batch is one HTTP call to a
// box with a 10s client timeout).
export const maxDuration = 300;

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
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
