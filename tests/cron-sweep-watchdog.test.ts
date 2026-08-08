import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  EDGE_REQUEST_CEILING_MS,
  SWEEP_EXPECTATIONS,
  SWEEP_SLOW_MS,
  WATCHDOG_SWEEP,
  evaluateSweepHealth,
  latestRuns,
  type HttpFailureRow,
  type SweepRunRow
} from "@/lib/cron/sweep-watchdog";

const NOW = Date.parse("2026-08-08T03:30:00.000Z");

function minutesBefore(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function run(overrides: Partial<SweepRunRow> & { sweep: string }): SweepRunRow {
  return {
    finished_at: minutesBefore(10),
    duration_ms: 1000,
    ok: true,
    error_count: 0,
    errors: [],
    ...overrides
  };
}

/**
 * A full clean fleet: one recent healthy run for every expected sweep. Tests
 * start from this and break exactly one thing, so a finding can only come
 * from what the test broke.
 */
function healthyFleet(): SweepRunRow[] {
  return Object.keys(SWEEP_EXPECTATIONS).map((sweep) => run({ sweep }));
}

function evaluate(
  runs: SweepRunRow[],
  httpFailures: HttpFailureRow[] = [],
  ledgerOldestAt: string | null = minutesBefore(60 * 24 * 30)
) {
  return evaluateSweepHealth({ runs, httpFailures, ledgerOldestAt, now: NOW });
}

describe("latestRuns", () => {
  it("keeps the newest run per sweep regardless of input order", () => {
    const rows = [
      run({ sweep: "outreach-sweep", finished_at: minutesBefore(30), duration_ms: 1 }),
      run({ sweep: "outreach-sweep", finished_at: minutesBefore(5), duration_ms: 2 }),
      run({ sweep: "outreach-sweep", finished_at: minutesBefore(60), duration_ms: 3 })
    ];
    expect(latestRuns(rows).get("outreach-sweep")?.duration_ms).toBe(2);
  });
});

describe("evaluateSweepHealth", () => {
  it("says nothing when every sweep reported in clean", () => {
    const result = evaluate(healthyFleet());
    expect(result.findings).toEqual([]);
    expect(result.healthy).toHaveLength(Object.keys(SWEEP_EXPECTATIONS).length);
    expect(result.checked).toBe(Object.keys(SWEEP_EXPECTATIONS).length);
  });

  it("reports a sweep with no run at all as stopped", () => {
    const runs = healthyFleet().filter((r) => r.sweep !== "subscription-grace-sweep");
    const finding = evaluate(runs).findings.find((f) => f.sweep === "subscription-grace-sweep");
    expect(finding?.kind).toBe("missing");
    expect(finding?.detail).toContain("no run recorded");
    expect(finding?.action).toContain("read-cron-jobs.ts");
  });

  it("reports a sweep whose last run is older than its own max gap", () => {
    const runs = healthyFleet().map((r) =>
      // Daily sweep, 1500 minute gap; 3000 minutes is unambiguously stopped.
      r.sweep === "data-retention-sweep" ? { ...r, finished_at: minutesBefore(3000) } : r
    );
    const finding = evaluate(runs).findings.find((f) => f.sweep === "data-retention-sweep");
    expect(finding?.kind).toBe("missing");
    expect(finding?.detail).toContain("3000 minutes ago");
  });

  it("does not call a daily sweep missing just because it ran 20 hours ago", () => {
    const runs = healthyFleet().map((r) =>
      r.sweep === "analytics-snapshot-sweep" ? { ...r, finished_at: minutesBefore(1200) } : r
    );
    expect(evaluate(runs).findings).toEqual([]);
  });

  it("cannot call anything missing until the ledger is older than the gap", () => {
    // Nothing recorded at all, and the ledger itself is 5 minutes old, which
    // is under even the tightest max gap: this is the hour the feature ships,
    // not an outage.
    const result = evaluate([], [], minutesBefore(5));
    expect(result.findings).toEqual([]);
  });

  it("treats an entirely empty ledger the same way, rather than paging about everything", () => {
    expect(evaluate([], [], null).findings).toEqual([]);
  });

  it("still reports the every-minute sweeps once the ledger is an hour old", () => {
    // A 15 minute gap is exceeded by a 60 minute ledger, so absence is real
    // for those, while the daily sweeps stay unjudged.
    const result = evaluate([], [], minutesBefore(60));
    const names = result.findings.map((f) => f.sweep);
    expect(names).toContain("email-campaign-sweep");
    expect(names).not.toContain("analytics-snapshot-sweep");
  });

  it("never reports the watchdog itself as missing, since it is the thing reporting", () => {
    const runs = healthyFleet().filter((r) => r.sweep !== WATCHDOG_SWEEP);
    const found = evaluate(runs).findings.filter((f) => f.sweep === WATCHDOG_SWEEP);
    expect(found).toEqual([]);
  });

  it("does not report the watchdog as missing on a stale row either", () => {
    const runs = healthyFleet().map((r) =>
      r.sweep === WATCHDOG_SWEEP ? { ...r, finished_at: minutesBefore(99_999) } : r
    );
    expect(evaluate(runs).findings.filter((f) => f.kind === "missing")).toEqual([]);
  });

  it("reports a crashed sweep with the thrown message", () => {
    const runs = healthyFleet().map((r) =>
      r.sweep === "outreach-sweep"
        ? { ...r, ok: false, error_count: 1, errors: ["connection reset"] }
        : r
    );
    const finding = evaluate(runs).findings.find((f) => f.sweep === "outreach-sweep");
    expect(finding?.kind).toBe("failed");
    expect(finding?.detail).toContain("connection reset");
  });

  it("reports a crashed sweep even when no error text was captured", () => {
    const runs = healthyFleet().map((r) =>
      r.sweep === "outreach-sweep" ? { ...r, ok: false, error_count: 1, errors: [] } : r
    );
    const finding = evaluate(runs).findings.find((f) => f.sweep === "outreach-sweep");
    expect(finding?.detail).toContain("no error recorded");
  });

  it("reports the silent-200 case: ok true with errors inside", () => {
    const runs = healthyFleet().map((r) =>
      r.sweep === "data-retention-sweep"
        ? { ...r, error_count: 4, errors: ["a", "b", "c", "d"] }
        : r
    );
    const finding = evaluate(runs).findings.find((f) => f.sweep === "data-retention-sweep");
    expect(finding?.kind).toBe("errors");
    expect(finding?.detail).toContain("4 error(s)");
    // Only the first three are quoted, so one bad night cannot fill the email.
    expect(finding?.detail).toContain("a; b; c");
    expect(finding?.detail).not.toContain("; d");
    expect(finding?.action).toContain("silent-200");
  });

  it("reports a sweep drifting toward the Edge ceiling before it breaches it", () => {
    const runs = healthyFleet().map((r) =>
      r.sweep === "analytics-snapshot-sweep" ? { ...r, duration_ms: SWEEP_SLOW_MS + 1 } : r
    );
    const finding = evaluate(runs).findings.find((f) => f.kind === "slow");
    expect(finding?.sweep).toBe("analytics-snapshot-sweep");
    expect(finding?.action).toContain(String(EDGE_REQUEST_CEILING_MS / 1000));
  });

  it("does not flag a sweep sitting exactly on the warning line", () => {
    const runs = healthyFleet().map((r) =>
      r.sweep === "analytics-snapshot-sweep" ? { ...r, duration_ms: SWEEP_SLOW_MS } : r
    );
    expect(evaluate(runs).findings).toEqual([]);
  });

  it("reports a sweep that is both failing and slow, once for each", () => {
    const runs = healthyFleet().map((r) =>
      r.sweep === "outreach-sweep"
        ? { ...r, ok: false, errors: ["boom"], error_count: 1, duration_ms: SWEEP_SLOW_MS + 1 }
        : r
    );
    const kinds = evaluate(runs)
      .findings.filter((f) => f.sweep === "outreach-sweep")
      .map((f) => f.kind);
    expect(kinds).toEqual(["failed", "slow"]);
  });

  it("does not check a missing sweep for failure or duration", () => {
    // A sweep with no row cannot also be slow; only the missing finding.
    const runs = healthyFleet().filter((r) => r.sweep !== "vps-orphan-sweep");
    const found = evaluate(runs).findings.filter((f) => f.sweep === "vps-orphan-sweep");
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("missing");
  });

  it("excludes a flagged sweep from the healthy list", () => {
    const runs = healthyFleet().map((r) =>
      r.sweep === "outreach-sweep" ? { ...r, error_count: 1, errors: ["x"] } : r
    );
    expect(evaluate(runs).healthy).not.toContain("outreach-sweep");
  });

  it("surfaces HTTP-layer failures, which no sweep can report about itself", () => {
    const failures: HttpFailureRow[] = [
      {
        id: 1,
        status_code: null,
        timed_out: true,
        error_msg: null,
        created: "2026-08-08T02:50:01Z"
      },
      {
        id: 2,
        status_code: 502,
        timed_out: false,
        error_msg: "failed sending data to the peer",
        created: "2026-08-08T01:35:02Z"
      }
    ];
    const findings = evaluate(healthyFleet(), failures).findings;
    expect(findings).toHaveLength(2);
    expect(findings[0].kind).toBe("http");
    expect(findings[0].sweep).toBe("(fleet)");
    expect(findings[0].detail).toContain("TIMED OUT");
    expect(findings[0].detail).toContain("status none");
    expect(findings[1].detail).toContain("502");
    expect(findings[1].detail).toContain("failed sending data to the peer");
  });

  it("orders findings worst first: stopped, crashed, partial, slow, http", () => {
    const runs = healthyFleet()
      .filter((r) => r.sweep !== "vps-orphan-sweep")
      .map((r) => {
        if (r.sweep === "outreach-sweep") return { ...r, ok: false, error_count: 1, errors: ["x"] };
        if (r.sweep === "data-retention-sweep") return { ...r, error_count: 2, errors: ["y", "z"] };
        if (r.sweep === "blog-publish-sweep") return { ...r, duration_ms: SWEEP_SLOW_MS + 1 };
        return r;
      });
    const failures: HttpFailureRow[] = [
      { id: 9, status_code: 504, timed_out: true, error_msg: null, created: "2026-08-08T03:00:00Z" }
    ];
    expect(evaluate(runs, failures).findings.map((f) => f.kind)).toEqual([
      "missing",
      "failed",
      "errors",
      "slow",
      "http"
    ]);
  });
});

/**
 * The expectations table is the watchdog's only idea of what SHOULD run, so
 * it has to match the real fleet exactly. A sweep missing from it is never
 * watched; a stale entry pages forever about a job that no longer exists.
 *
 * Discovery mirrors tests/cron-timeout-parity.test.ts so a new cron job
 * forces someone to state its cadence here on the day it lands.
 */
describe("SWEEP_EXPECTATIONS covers exactly the scheduled pass-through fleet", () => {
  const ROOT = process.cwd();

  function passthroughRoutes(): string[] {
    const byName = new Map<string, string | null>();
    const migrations = join(ROOT, "supabase", "migrations");
    for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(join(migrations, file), "utf8");
      for (const block of sql.split(/cron\.schedule\s*\(/).slice(1)) {
        const job = block.match(/^\s*'([^']+)'/)?.[1];
        if (!job) continue;
        const fn = block.match(/\/functions\/v1\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
        byName.set(job, fn ?? byName.get(job) ?? null);
      }
    }
    const routes = new Set<string>();
    for (const fn of byName.values()) {
      if (!fn) continue;
      const path = join(ROOT, "supabase", "functions", fn, "index.ts");
      if (!existsSync(path)) continue;
      const src = readFileSync(path, "utf8");
      const found = [
        ...new Set([...src.matchAll(/\/api\/internal\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]))
      ];
      if (found.length === 1 && /REQUEST_TIMEOUT_MS\s*=\s*[0-9_]+/.test(src)) routes.add(found[0]);
    }
    return [...routes].sort();
  }

  it("has an entry for every scheduled sweep and no entry for anything else", () => {
    expect(Object.keys(SWEEP_EXPECTATIONS).sort()).toEqual(passthroughRoutes());
  });

  it("gives every sweep a gap longer than a single period, so one hiccup is not an alert", () => {
    for (const [sweep, { maxGapMinutes }] of Object.entries(SWEEP_EXPECTATIONS)) {
      expect(maxGapMinutes, `${sweep} has an unusable max gap`).toBeGreaterThanOrEqual(15);
    }
  });
});
