/**
 * Internal, cron-triggered document expiration sweep.
 *
 * Call chain: pg_cron → Edge `document-expiration-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Notifies owners about documents expiring within the reminder window and
 * about just-expired ones, once per state (armed/cleared stamps). The
 * agent-side exclusion of expired docs happens at read time; this is only
 * the reminder half.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { sweepDocumentExpirations } from "@/lib/documents/expiration";

export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const result = await sweepDocumentExpirations();
    const durationMs = Date.now() - startedAt;
    logger.info("document-expiration-sweep: summary", { ...result, durationMs });
    return successResponse({ ...result, durationMs });
  } catch (err) {
    logger.error("document-expiration-sweep: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Sweep failed", 500);
  }
}
