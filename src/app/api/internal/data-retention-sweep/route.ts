/**
 * Internal, cron-triggered retention sweep (security review G6).
 *
 * Call chain: pg_cron → Edge `data-retention-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * For every business with `data_retention_days` set, prunes content history
 * older than the window via `pruneExpiredContent` (residency-aware: dual/vps
 * tenants are pruned on their box too). Per-tenant errors are captured and
 * the sweep continues — one unreachable box can't block the fleet; every
 * delete is idempotent so tomorrow's run converges.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { listBusinessesWithRetention } from "@/lib/db/businesses";
import { pruneExpiredContent } from "@/lib/privacy/retention";

// A fleet-wide sweep does many small deletes (and box round-trips for
// residency tenants); pin the Vercel ceiling like the other sweeps.
export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();

  let targets;
  try {
    targets = await listBusinessesWithRetention();
  } catch (err) {
    logger.error("data-retention-sweep: listBusinessesWithRetention failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Failed to list retention targets", 500);
  }

  let pruned = 0;
  let centralRows = 0;
  let boxRows = 0;
  const errors: Array<{ businessId: string; message: string }> = [];

  for (const target of targets) {
    try {
      const res = await pruneExpiredContent(target.id, target.data_retention_days);
      pruned += 1;
      centralRows += res.tables.reduce((s, t) => s + t.central, 0);
      boxRows += res.tables.reduce((s, t) => s + (t.box ?? 0), 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ businessId: target.id, message });
      logger.error("data-retention-sweep: tenant prune failed; continuing", {
        businessId: target.id,
        error: message
      });
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.info("data-retention-sweep: summary", {
    targets: targets.length,
    pruned,
    centralRows,
    boxRows,
    errors: errors.length,
    durationMs
  });

  return successResponse({
    targets: targets.length,
    pruned,
    centralRows,
    boxRows,
    errors,
    durationMs
  });
}
