/**
 * Internal, cron-triggered Smart List action sweep.
 *
 * Call chain: pg_cron -> Edge `segment-action-sweep` -> this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * For every business's enabled segment actions, adds the configured tag to
 * matching contacts through the shared tag-write path (goal events +
 * tag_changed contact events), see
 * supabase/functions/_shared/segment_actions.ts.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { runSegmentActionSweep } from "../../../../../supabase/functions/_shared/segment_actions";

// 150 matches the chain's reachable budget: Supabase 504s the Edge bridge at
// 150s. The sweep itself is bounded (200 tag writes per business per run),
// so a longer declaration would only grant unused background time.
export const maxDuration = 150;
export const runtime = "nodejs";

async function runSweep(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const db = await createSupabaseServiceClient();
    const result = await runSegmentActionSweep(db);
    const durationMs = Date.now() - startedAt;
    // Quiet nights (no enabled actions, nothing tagged) stay unlogged.
    if (
      result.segments ||
      result.tagsWritten ||
      result.cappedBusinesses.length ||
      result.errors.length
    ) {
      logger.info("segment-action-sweep: summary", { ...result, durationMs });
    }
    return successResponse({ ...result, durationMs });
  } catch (err) {
    logger.error("segment-action-sweep: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Sweep failed", 500);
  }
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("segment-action-sweep", runSweep);
