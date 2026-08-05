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
import { logger } from "@/lib/logger";
import { sweepContractTermNudges } from "@/lib/billing/contract-term-nudge";

export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
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
