/**
 * Internal, cron-triggered month-to-month intro nudge sweep.
 *
 * Call chain: pg_cron → Edge `monthly-intro-nudge-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Emails each eligible first-month monthly subscriber once, 5 business days
 * before their first renewal (Shape B soft notice + contract options).
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { sweepMonthlyIntroNudges } from "@/lib/billing/monthly-intro-nudge";

export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const result = await sweepMonthlyIntroNudges();
    const durationMs = Date.now() - startedAt;
    logger.info("monthly-intro-nudge-sweep: summary", { ...result, durationMs });
    return successResponse({ ...result, durationMs });
  } catch (err) {
    logger.error("monthly-intro-nudge-sweep: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Sweep failed", 500);
  }
}
