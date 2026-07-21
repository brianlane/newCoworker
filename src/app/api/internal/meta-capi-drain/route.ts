/**
 * Internal Meta Conversion Leads drain endpoint.
 *
 * Call chain: pg_cron → Edge `meta-capi-drain` → this route (per-minute).
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Drains a bounded batch of pending meta_capi_events rows via
 * drainMetaCapiEvents (identifier resolution → Conversions API upload →
 * terminal-state bookkeeping).
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { drainMetaCapiEvents } from "@/lib/meta/capi-drain";
import { logger } from "@/lib/logger";

// A batch of 50 uploads at ~1s of Graph latency each needs headroom.
export const maxDuration = 120;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  const summary = await drainMetaCapiEvents();
  const durationMs = Date.now() - startedAt;

  if (summary.claimed > 0) {
    logger.info("meta-capi-drain: summary", { ...summary, durationMs });
  }
  return successResponse({ ...summary, durationMs });
}
