import { describe, expect, it, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceDb } from "./harness";

/**
 * cron_sweep_run_evidence against the REAL stack: the actual PostgREST row
 * cap, the actual RPC, the actual table.
 *
 * Why this exists: the watchdog's 2026-08-10 email reported seven healthy
 * daily sweeps as STOPPED. The route read its 8-day window with a plain
 * windowed select, and PostgREST caps an un-limited select at 1,000 rows;
 * the fleet's ~8,800 cron rows per day truncated the newest-first read to
 * ~3 hours, hiding every older daily. Nothing short of a real PostgREST in
 * front of a real table can assert that failure mode, so the first test
 * REPRODUCES the trap and the rest pin the RPC that replaces the select.
 */

const MINUTELY_SWEEP = "itest-evidence-minutely";
const DAILY_SWEEP = "itest-evidence-daily";
const FAILING_SWEEP = "itest-evidence-failing";
const DIRECT_ONLY_SWEEP = "itest-evidence-direct-only";
const CRON_SOURCE = "itest-bridge";

/** Enough rows that the daily sweep's run sits beyond the 1,000-row cap. */
const MINUTELY_ROWS = 1_100;

function runRow(over: {
  sweep: string;
  finishedAt: Date;
  ok?: boolean;
  errorCount?: number;
  source?: string;
}) {
  return {
    sweep: over.sweep,
    started_at: new Date(over.finishedAt.getTime() - 1000).toISOString(),
    finished_at: over.finishedAt.toISOString(),
    duration_ms: 1000,
    ok: over.ok ?? true,
    error_count: over.errorCount ?? 0,
    errors: [],
    summary: {},
    source: over.source ?? CRON_SOURCE
  };
}

describe("cron_sweep_run_evidence", () => {
  let db: SupabaseClient;
  const now = Date.now();
  // Older than every minutely row, newer than the 8-day lookback: the shape
  // of a healthy daily sweep the capped select was hiding.
  const dailyFinishedAt = new Date(now - 20 * 3_600_000);

  beforeAll(async () => {
    db = serviceDb();
    await db
      .from("cron_sweep_runs")
      .delete()
      .in("sweep", [MINUTELY_SWEEP, DAILY_SWEEP, FAILING_SWEEP, DIRECT_ONLY_SWEEP]);

    const rows = [
      runRow({ sweep: DAILY_SWEEP, finishedAt: dailyFinishedAt }),
      runRow({ sweep: FAILING_SWEEP, finishedAt: new Date(now - 19 * 3_600_000), ok: false }),
      runRow({ sweep: DIRECT_ONLY_SWEEP, finishedAt: new Date(now - 60_000), source: "direct" })
    ];
    for (let i = 0; i < MINUTELY_ROWS; i++) {
      rows.push(runRow({ sweep: MINUTELY_SWEEP, finishedAt: new Date(now - i * 60_000) }));
    }
    // Chunked: one insert of 1,103 rows is within PostgREST's request limits
    // but chunking keeps each payload small and the failure, if any, local.
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("cron_sweep_runs").insert(rows.slice(i, i + 500));
      expect(error).toBeNull();
    }
  });

  it("REPRODUCES the trap: a windowed select caps at 1,000 rows and hides the daily", async () => {
    const since = new Date(now - 8 * 24 * 3_600_000).toISOString();
    const { data, error } = await db
      .from("cron_sweep_runs")
      .select("sweep, finished_at")
      .neq("source", "direct")
      .gte("finished_at", since)
      .order("finished_at", { ascending: false });
    expect(error).toBeNull();
    // The cap itself. If Supabase ever raises the default this assertion
    // goes stale loudly, which is exactly when the RPC should be revisited.
    expect(data?.length).toBeLessThanOrEqual(1000);
    // There are 1,100 newer minutely rows, so the capped read cannot reach
    // the daily. This is the "healthy sweep reported STOPPED" mechanism.
    const sweeps = new Set((data ?? []).map((r) => r.sweep));
    expect(sweeps.has(DAILY_SWEEP)).toBe(false);
  });

  it("returns the latest row per sweep, including the daily the select hid", async () => {
    const { data, error } = await db.rpc("cron_sweep_run_evidence", {
      since_minutes: 8 * 24 * 60
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ sweep: string; finished_at: string; ok: boolean }>;

    const daily = rows.filter((r) => r.sweep === DAILY_SWEEP);
    expect(daily).toHaveLength(1);
    expect(new Date(daily[0].finished_at).getTime()).toBe(dailyFinishedAt.getTime());

    // The minutely sweep collapses to its single latest row, so the result
    // is bounded by fleet size, not by chatter.
    expect(rows.filter((r) => r.sweep === MINUTELY_SWEEP)).toHaveLength(1);
  });

  it("carries every failing row and excludes direct runs", async () => {
    const { data, error } = await db.rpc("cron_sweep_run_evidence", {
      since_minutes: 8 * 24 * 60
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ sweep: string; ok: boolean }>;
    expect(rows.some((r) => r.sweep === FAILING_SWEEP && r.ok === false)).toBe(true);
    // Direct runs are debugging data, not evidence a SCHEDULE is alive.
    expect(rows.some((r) => r.sweep === DIRECT_ONLY_SWEEP)).toBe(false);
  });
});
