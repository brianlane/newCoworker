/**
 * Internal, cron-triggered usage-pack auto-reload sweep.
 *
 * Call chain: pg_cron -> Edge `usage-pack-auto-reload-sweep` -> this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Lives in the Next app rather than the edge function because the balance
 * math needs contracts that only exist here (the tier-and-env chat base cap,
 * the Mexico SMS clamp) and the charge needs the Stripe Node SDK.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { sweepUsagePackAutoReloads } from "@/lib/billing/auto-reload-sweep";

// 150 matches the chain's reachable budget: Supabase 504s the Edge bridge
// at 150s, and this sweep's worst run in the ledger's first full week was
// 1.5s (cron_sweep_runs, 2026-08-15). Declaring more only granted unused
// background time after the 504.
export const maxDuration = 150;
export const runtime = "nodejs";

async function runSweep(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  // Two jobs hit this route. `?mode=flagged` runs every minute over only the
  // rules a consume path stamped; anything else is the 15 minute full rescan.
  // Unrecognised values fall back to the full scan, which is the safe default:
  // it can only do more work, never less.
  const mode = new URL(request.url).searchParams.get("mode") === "flagged" ? "flagged" : "full";

  const startedAt = Date.now();
  try {
    const result = await sweepUsagePackAutoReloads({ mode });
    const durationMs = Date.now() - startedAt;
    logger.info("usage-pack-auto-reload-sweep: summary", { ...result, mode, durationMs });
    return successResponse({ ...result, mode, durationMs });
  } catch (err) {
    logger.error("usage-pack-auto-reload-sweep: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Sweep failed", 500);
  }
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("usage-pack-auto-reload-sweep", runSweep);
