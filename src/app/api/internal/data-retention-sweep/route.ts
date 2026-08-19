/**
 * Internal, cron-triggered retention sweep (security review G6).
 *
 * Call chain: pg_cron → Edge `data-retention-sweep` → this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * For every business with `data_retention_days` set, prunes content history
 * older than the window via `pruneExpiredContent` (residency-aware: dual/vps
 * tenants are pruned on their box too). Per-tenant errors are captured and
 * the sweep continues, one unreachable box can't block the fleet; every
 * delete is idempotent so tomorrow's run converges.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { listBusinessesWithRetention } from "@/lib/db/businesses";
import { pruneExpiredContent } from "@/lib/privacy/retention";
import { pruneKgRetrievalEvents } from "@/lib/memory/kg-events";
import { pruneAiTrafficEvents } from "@/lib/marketing/ai-traffic";

// A fleet-wide sweep does many small deletes (and box round-trips for
// residency tenants); pin the Vercel ceiling like the other sweeps.
// 150 matches the chain's reachable budget: Supabase 504s the Edge bridge
// at 150s, and this sweep's worst run in the ledger's first full week was
// 0.2s (cron_sweep_runs, 2026-08-15). Declaring more only granted unused
// background time after the 504.
export const maxDuration = 150;
export const runtime = "nodejs";

async function runSweep(request: Request): Promise<Response> {
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

  // Fixed 90-day platform prune of the KG comparison ledger, independent
  // of tenant retention settings (kg_retrieval_events is an ops artifact,
  // not tenant-configurable history). A failure logs and retries tomorrow.
  let kgEventsPruned = 0;
  try {
    kgEventsPruned = await pruneKgRetrievalEvents();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ businessId: "platform:kg_retrieval_events", message });
    logger.error("data-retention-sweep: kg_retrieval_events prune failed", { error: message });
  }

  // Same fixed 90-day platform prune for the AI-traffic ledger: ops data
  // about crawlers and referrers, not tenant content.
  let aiTrafficPruned = 0;
  try {
    aiTrafficPruned = await pruneAiTrafficEvents();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ businessId: "platform:ai_traffic_events", message });
    logger.error("data-retention-sweep: ai_traffic_events prune failed", { error: message });
  }

  const durationMs = Date.now() - startedAt;
  logger.info("data-retention-sweep: summary", {
    targets: targets.length,
    pruned,
    centralRows,
    boxRows,
    kgEventsPruned,
    aiTrafficPruned,
    errors: errors.length,
    durationMs
  });

  return successResponse({
    targets: targets.length,
    pruned,
    centralRows,
    boxRows,
    kgEventsPruned,
    aiTrafficPruned,
    errors,
    durationMs
  });
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("data-retention-sweep", runSweep);
