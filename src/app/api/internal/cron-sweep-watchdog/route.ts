/**
 * Internal, cron-triggered watchdog over the scheduled sweep fleet.
 *
 * Call chain: pg_cron -> Edge `cron-sweep-watchdog` -> this route.
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 *
 * Runs at 03:30 UTC, after the four overnight sweeps and inside the ~6h
 * net._http_response retention window of the earliest of them. Reads both
 * halves of the record (see src/lib/cron/sweep-watchdog.ts for why one is
 * not enough), and emails the operator ONLY when there are findings.
 */

import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, successResponse } from "@/lib/api-response";
import { DIRECT_SOURCE, withSweepRun } from "@/lib/cron/sweep-run";
import { logger } from "@/lib/logger";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { sendOpsCronSweepHealthEmail } from "@/lib/email/ops-notify";
import {
  SWEEP_EXPECTATIONS,
  evaluateSweepHealth,
  type HttpFailureRow,
  type SweepRunRow
} from "@/lib/cron/sweep-watchdog";

// A couple of indexed reads and one email. Set to exactly the Edge ceiling
// so this route never joins KNOWN_ABOVE_EDGE_CEILING.
export const maxDuration = 150;
export const runtime = "nodejs";

/**
 * Lookback for the run ledger: wide enough to cover the longest max gap in
 * SWEEP_EXPECTATIONS (the weekly blog digest at 10,200 minutes) plus room,
 * so a weekly sweep is judged against real history rather than an empty
 * window.
 */
const LOOKBACK_MINUTES = 11_520; // 8 days

/** net._http_response only retains ~6h, so asking for more is pointless. */
const HTTP_LOOKBACK_MINUTES = 360;

async function runSweep(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }

  const startedAt = Date.now();
  try {
    const supabase = await createSupabaseServiceClient();
    const since = new Date(startedAt - LOOKBACK_MINUTES * 60_000).toISOString();

    // Cron-sourced rows only, on both queries. The cron bearer is not
    // exclusive to pg_cron (the Meta webhook kicks messenger-worker with it
    // on every inbound message), so counting direct runs would let webhook
    // traffic stand in for a dead cron job. Direct runs stay in the table
    // for debugging; they are just not evidence that a SCHEDULE is alive.
    const [runsResult, oldestResult, httpResult] = await Promise.all([
      supabase
        .from("cron_sweep_runs")
        .select("sweep, finished_at, duration_ms, ok, error_count, errors")
        .neq("source", DIRECT_SOURCE)
        .gte("finished_at", since)
        .order("finished_at", { ascending: false }),
      // The ledger's own age. Without it, every sweep looks "missing" on the
      // day this ships, and again any time a prune empties the table.
      supabase
        .from("cron_sweep_runs")
        .select("finished_at")
        .neq("source", DIRECT_SOURCE)
        .order("finished_at", { ascending: true })
        .limit(1),
      supabase.rpc("cron_http_failures", { since_minutes: HTTP_LOOKBACK_MINUTES })
    ]);

    if (runsResult.error) {
      logger.error("cron-sweep-watchdog: could not read cron_sweep_runs", {
        error: runsResult.error.message
      });
      return errorResponse("DB_ERROR", "Could not read the sweep run ledger", 500);
    }
    if (httpResult.error) {
      // Not fatal. The HTTP half is a bonus signal; losing it must not cost
      // us the "a sweep has stopped" alert, which is the important one.
      logger.warn("cron-sweep-watchdog: could not read cron_http_failures", {
        error: httpResult.error.message
      });
    }

    const result = evaluateSweepHealth({
      runs: (runsResult.data ?? []) as SweepRunRow[],
      httpFailures: httpResult.error ? [] : ((httpResult.data ?? []) as HttpFailureRow[]),
      // Reported as its own "degraded" finding, NOT folded into this run's
      // errors[]: the recorder reads errors[] as per-tenant work failures,
      // so putting an infrastructure problem there would make the next run
      // classify it as a silent-200 and print per-tenant remediation for
      // what is really a missing migration or grant.
      httpReadError: httpResult.error ? httpResult.error.message : null,
      ledgerOldestAt: oldestResult.data?.[0]?.finished_at ?? null,
      now: startedAt
    });

    let emailed = false;
    if (result.findings.length > 0) {
      emailed = await sendOpsCronSweepHealthEmail({
        findings: result.findings,
        healthy: result.healthy,
        checked: result.checked
      });
    }

    const durationMs = Date.now() - startedAt;
    const summary = {
      sweeps: Object.keys(SWEEP_EXPECTATIONS).length,
      findings: result.findings.length,
      byKind: result.findings.reduce<Record<string, number>>((acc, f) => {
        acc[f.kind] = (acc[f.kind] ?? 0) + 1;
        return acc;
      }, {}),
      healthy: result.healthy.length,
      httpFailures: result.findings.filter((f) => f.kind === "http").length,
      emailed,
      // Deliberately not named "errors": that key is the per-tenant work
      // failure list the recorder counts. This run did its work fine, it
      // just did it half-blind, which the degraded finding above reports.
      httpReadError: httpResult.error?.message ?? null,
      durationMs
    };
    logger.info("cron-sweep-watchdog: summary", summary);
    return successResponse(summary);
  } catch (err) {
    logger.error("cron-sweep-watchdog: failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return errorResponse("INTERNAL_SERVER_ERROR", "Watchdog failed", 500);
  }
}

// Every run lands in public.cron_sweep_runs; see src/lib/cron/sweep-run.ts.
export const POST = withSweepRun("cron-sweep-watchdog", runSweep);
