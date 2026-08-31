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
  sweepSlowMs,
  type HttpFailureRow,
  type SweepRunRow
} from "@/lib/cron/sweep-watchdog";
import {
  OWNER_FALLBACK_PAGE_AT,
  OWNER_FALLBACK_ROW_CAP,
  type OwnerFallbackRow
} from "@/lib/cron/owner-operator-fallback";

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
  ledgerOldestAt: string | null = minutesBefore(60 * 24 * 30),
  httpReadError: string | null = null,
  previouslyMissing: string[] | null = null,
  // Default: no owner fallbacks, the measured production baseline, so every
  // existing sweep assertion keeps reading exactly what it read before.
  ownerFallbacks: OwnerFallbackRow[] = [],
  ownerFallbacksTruncated = false
) {
  return evaluateSweepHealth({
    runs,
    httpFailures,
    ledgerOldestAt,
    httpReadError,
    previouslyMissing,
    ownerFallbacks,
    ownerFallbacksTruncated,
    ownerFallbackWindowMinutes: 1_440,
    now: NOW
  });
}

function httpRow(minutesAgoCreated: number, over: Partial<HttpFailureRow> = {}): HttpFailureRow {
  return {
    id: 1,
    status_code: 502,
    timed_out: false,
    error_msg: null,
    created: minutesBefore(minutesAgoCreated),
    ...over
  };
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

  it("stays quiet when a migration sweep runs long, which is what a migration DOES", () => {
    // 2026-08-30, verbatim: vps-term-renewal-sweep ran 552.3s and paged SLOW,
    // and the run had SUCCEEDED (it bought a term box and moved a tenant onto
    // it). Its own advice, "shrink the per-run batch", is unfollowable: the
    // sweep migrates at most one tenant per run.
    const runs = healthyFleet().map((r) =>
      r.sweep === "vps-term-renewal-sweep" ? { ...r, duration_ms: 552_304 } : r
    );
    expect(evaluate(runs).findings).toEqual([]);
  });

  it("still reports a migration sweep closing on its OWN maxDuration", () => {
    // Raised, not removed. Past this line Vercel truncates the run, and a
    // migration cut off mid-cutover is the failure the path exists to avoid.
    const slowMs = sweepSlowMs("vps-term-renewal-sweep");
    const runs = healthyFleet().map((r) =>
      r.sweep === "vps-term-renewal-sweep" ? { ...r, duration_ms: slowMs + 1 } : r
    );
    const finding = evaluate(runs).findings.find((f) => f.kind === "slow");
    expect(finding?.sweep).toBe("vps-term-renewal-sweep");
    expect(finding?.detail).toContain(`${slowMs / 1000}s warning line`);
    // The Edge-ceiling remediation is wrong for this sweep and must not appear.
    expect(finding?.action).toContain("its OWN");
    expect(finding?.action).not.toContain("shrink the per-run batch");
  });

  it("keeps the Edge-ceiling advice for a sweep judged on the default line", () => {
    const runs = healthyFleet().map((r) =>
      r.sweep === "outreach-sweep" ? { ...r, duration_ms: SWEEP_SLOW_MS + 1 } : r
    );
    const finding = evaluate(runs).findings.find((f) => f.kind === "slow");
    expect(finding?.action).toContain("shrink the per-run batch");
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

  it("reports a blind HTTP read as its own kind, not as a per-tenant failure", () => {
    // Folding this into errors[] would make the NEXT run read it back as a
    // silent-200 and print per-tenant remediation for a missing grant.
    const result = evaluate(healthyFleet(), [], minutesBefore(60 * 24 * 30), "function does not exist");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("degraded");
    expect(result.findings[0].sweep).toBe(WATCHDOG_SWEEP);
    expect(result.findings[0].detail).toContain("function does not exist");
    expect(result.findings[0].action).toContain("cron_http_failures(integer)");
  });

  it("carries each anomaly's detail inside a burst finding, since no sweep can report them", () => {
    // Three inside an hour: past the pager bar, so the finding must let the
    // operator see every row without a second query.
    const failures: HttpFailureRow[] = [
      { id: 1, status_code: null, timed_out: true, error_msg: null, created: minutesBefore(10) },
      {
        id: 2,
        status_code: 502,
        timed_out: false,
        error_msg: "failed sending data to the peer",
        created: minutesBefore(25)
      },
      { id: 3, status_code: 500, timed_out: false, error_msg: null, created: minutesBefore(40) }
    ];
    const findings = evaluate(healthyFleet(), failures).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("burst");
    expect(findings[0].sweep).toBe("(fleet)");
    expect(findings[0].detail).toContain("TIMED OUT");
    expect(findings[0].detail).toContain("status none");
    expect(findings[0].detail).toContain("502");
    expect(findings[0].detail).toContain("failed sending data to the peer");
  });

  it("orders findings worst first: stopped, crashed, partial, slow, burst", () => {
    const runs = healthyFleet()
      .filter((r) => r.sweep !== "vps-orphan-sweep")
      .map((r) => {
        if (r.sweep === "outreach-sweep") return { ...r, ok: false, error_count: 1, errors: ["x"] };
        if (r.sweep === "data-retention-sweep") return { ...r, error_count: 2, errors: ["y", "z"] };
        if (r.sweep === "blog-publish-sweep") return { ...r, duration_ms: SWEEP_SLOW_MS + 1 };
        return r;
      });
    // A burst (three in an hour), so the HTTP layer still appears, last.
    const failures: HttpFailureRow[] = [
      { id: 9, status_code: 504, timed_out: true, error_msg: null, created: minutesBefore(5) },
      { id: 10, status_code: 502, timed_out: false, error_msg: null, created: minutesBefore(20) },
      { id: 11, status_code: 502, timed_out: false, error_msg: null, created: minutesBefore(35) }
    ];
    expect(
      evaluate(runs, failures, minutesBefore(60 * 24 * 30), "boom").findings.map((f) => f.kind)
    ).toEqual(["missing", "failed", "errors", "degraded", "slow", "burst"]);
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
    // Replay cron.schedule AND cron.unschedule in apply order (files sorted,
    // calls in document order). Replaying only schedules is the trap the
    // README's cron section warns about: an unschedule-ONLY migration
    // (20260812000200 turned residency-replay off while zero tenants use
    // residency) leaves the job in the "expected" fleet, and the watchdog
    // then emails ACTION REQUIRED every night for a sweep that is off by
    // design. The guard pattern (unschedule immediately before a re-schedule
    // in the same file) survives because document order deletes then re-adds.
    for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(join(migrations, file), "utf8");
      for (const m of sql.matchAll(/cron\.(schedule|unschedule)\s*\(\s*'([^']+)'/g)) {
        const [, kind, job] = m;
        if (kind === "unschedule") {
          byName.delete(job);
          continue;
        }
        const block = sql.slice(m.index).split(/cron\.schedule\s*\(/)[1] ?? "";
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

  it("does not expect a sweep whose job a later migration unscheduled", () => {
    // residency-replay is defined by 20260804000000 and deliberately turned
    // off by 20260812000200 while zero tenants use residency. Expecting it
    // makes the watchdog cry wolf nightly, which is how alert channels die.
    // If a future migration re-schedules the job, discovery re-includes it
    // and the exact-match test above forces the registry entry back.
    expect(passthroughRoutes()).not.toContain("residency-replay");
  });

  it("gives every sweep a gap longer than a single period, so one hiccup is not an alert", () => {
    for (const [sweep, { maxGapMinutes }] of Object.entries(SWEEP_EXPECTATIONS)) {
      expect(maxGapMinutes, `${sweep} has an unusable max gap`).toBeGreaterThanOrEqual(15);
    }
  });

  /**
   * A raised slow line is a promise about a specific budget, so it has to
   * track the budget. Read the route's own `maxDuration` rather than
   * restating it: lowering a route to 300s while its threshold still says
   * 1,440s would mute the sweep entirely, silently, and this is the check
   * that refuses to let that merge.
   */
  function routeMaxDurationSeconds(sweep: string): number | null {
    const path = join(ROOT, "src", "app", "api", "internal", sweep, "route.ts");
    if (!existsSync(path)) return null;
    const m = readFileSync(path, "utf8").match(/export const maxDuration\s*=\s*(\d+)/);
    return m ? Number(m[1]) : null;
  }

  it("sets every raised slow line to 80% of the budget its route actually declares", () => {
    for (const [sweep, { slowMs }] of Object.entries(SWEEP_EXPECTATIONS)) {
      if (slowMs === undefined) continue;
      const maxDuration = routeMaxDurationSeconds(sweep);
      expect(maxDuration, `${sweep} has a slowMs but no readable maxDuration`).not.toBeNull();
      expect(slowMs, `${sweep} slowMs drifted from its route budget`).toBe(
        Math.round((maxDuration as number) * 1000 * 0.8)
      );
    }
  });

  it("only raises the line for a route that declares more than the Edge ceiling", () => {
    // Below the ceiling the default 120s warning is real: the run genuinely
    // is approaching the 504. Raising the line there would hide it.
    for (const [sweep, { slowMs }] of Object.entries(SWEEP_EXPECTATIONS)) {
      if (slowMs === undefined) continue;
      const maxDurationMs = (routeMaxDurationSeconds(sweep) as number) * 1000;
      expect(maxDurationMs, `${sweep} does not need a raised line`).toBeGreaterThan(
        EDGE_REQUEST_CEILING_MS
      );
    }
  });

  it("gives a raised line to every sweep whose route outruns the Edge ceiling", () => {
    // The other direction: a long-budget sweep left on the default line pages
    // every time it does real work, which is the bug this pair exists to stop.
    for (const sweep of Object.keys(SWEEP_EXPECTATIONS)) {
      const maxDuration = routeMaxDurationSeconds(sweep);
      if (maxDuration === null || maxDuration * 1000 <= EDGE_REQUEST_CEILING_MS) continue;
      expect(sweepSlowMs(sweep), `${sweep} is judged on the default line`).toBeGreaterThan(
        SWEEP_SLOW_MS
      );
    }
  });
});

/**
 * The pager contract: an email means act. Solo HTTP anomalies have been
 * checked by hand six times (Aug 6-20) and were harmless every time, because
 * every real victim already pages through the ledger (a crashed run pages as
 * "failed", a stopped schedule pages as "missing" after its gap). So lone
 * anomalies are counted, not paged; only a BURST pages, which is the "two in
 * a row is a pattern" prose finally enforced with numbers.
 */
describe("HTTP anomalies page only in bursts", () => {
  it("suppresses a lone anomaly instead of paging", () => {
    const result = evaluate(healthyFleet(), [httpRow(30)]);
    expect(result.findings).toEqual([]);
    expect(result.suppressedHttp).toBe(1);
  });

  it("suppresses two anomalies hours apart", () => {
    const result = evaluate(healthyFleet(), [httpRow(30), httpRow(200)]);
    expect(result.findings).toEqual([]);
    expect(result.suppressedHttp).toBe(2);
  });

  it("pages one burst finding when three land inside an hour", () => {
    const result = evaluate(healthyFleet(), [httpRow(10), httpRow(30), httpRow(50)]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("burst");
    expect(result.findings[0].detail).toContain("3 anomalies");
    expect(result.suppressedHttp).toBe(0);
  });

  it("pages when five accumulate even without any dense hour", () => {
    const rows = [httpRow(10), httpRow(80), httpRow(150), httpRow(220), httpRow(290)];
    const result = evaluate(healthyFleet(), rows);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("burst");
  });
});

/**
 * A brand-new daily sweep merged after its UTC slot cannot record a run
 * until the next day, which produced a false ACTION REQUIRED twice in the
 * watchdog's first ten days. Grace: a sweep with no row at all is logged on
 * night one and pages on night two, using yesterday's own missing-set as
 * memory. The memory FAILS OPEN: if yesterday cannot be read, there is no
 * grace, because muting is the worse error.
 */
describe("new-sweep first-night grace", () => {
  const sweep = "subscription-grace-sweep";
  const runsWithout = () => healthyFleet().filter((r) => r.sweep !== sweep);

  it("logs but does not page a first-night absentee", () => {
    const result = evaluate(runsWithout(), [], minutesBefore(60 * 24 * 30), null, []);
    expect(result.findings).toEqual([]);
    expect(result.graced).toEqual([sweep]);
    // Tomorrow's memory must carry it so night two escalates.
    expect(result.missingSweeps).toContain(sweep);
  });

  it("pages on night two, when yesterday already saw it missing", () => {
    const result = evaluate(runsWithout(), [], minutesBefore(60 * 24 * 30), null, [sweep]);
    expect(result.findings.some((f) => f.kind === "missing" && f.sweep === sweep)).toBe(true);
    expect(result.graced).toEqual([]);
  });

  it("fails open: no yesterday means no grace", () => {
    const result = evaluate(runsWithout(), [], minutesBefore(60 * 24 * 30), null, null);
    expect(result.findings.some((f) => f.kind === "missing" && f.sweep === sweep)).toBe(true);
  });

  it("remembers youth-skipped sweeps as missing, so a pruned ledger cannot grant grace", () => {
    // Night after a prune: the ledger is younger than every gap, so absentees
    // are not paged. But storing missing: [] would hand the NEXT night
    // positive-looking evidence they were fine, and grace would mute a sweep
    // that has been dead since before the prune. The youth-skip must land in
    // the memory as missing.
    const young = minutesBefore(5);
    const nightOne = evaluate(runsWithout(), [], young, null, []);
    expect(nightOne.findings).toEqual([]);
    expect(nightOne.missingSweeps).toContain(sweep);
    // Night two, ledger old enough: yesterday's memory denies the grace.
    const nightTwo = evaluate(
      runsWithout(),
      [],
      minutesBefore(60 * 24 * 30),
      null,
      nightOne.missingSweeps
    );
    expect(nightTwo.findings.some((f) => f.kind === "missing" && f.sweep === sweep)).toBe(true);
    expect(nightTwo.graced).toEqual([]);
  });

  it("never graces a sweep that HAS history and stopped", () => {
    const runs = healthyFleet().map((r) =>
      r.sweep === sweep ? run({ sweep, finished_at: minutesBefore(3000) }) : r
    );
    const result = evaluate(runs, [], minutesBefore(60 * 24 * 30), null, []);
    expect(result.findings.some((f) => f.kind === "missing" && f.sweep === sweep)).toBe(true);
    expect(result.graced).toEqual([]);
  });
});

/**
 * Owner turns that fell off the platform engine onto the box worker.
 *
 * Not a sweep, and checked here because this watchdog is the one job that
 * already runs daily, reads a ledger and mails an operator. The pager rule is
 * the same one the HTTP layer follows: a lone anomaly is counted and stays
 * quiet, a pattern pages. The measured production baseline on 2026-08-24 was
 * ZERO fallbacks across 30 days and 30 owner turns, so this is tuned against
 * silence rather than against noise.
 */
describe("owner-operator fallbacks", () => {
  const fb = (reason: string, businessId = "biz-1"): OwnerFallbackRow => ({
    reason,
    created_at: minutesBefore(30),
    business_id: businessId
  });

  it("says nothing when there are none, which is the normal night", () => {
    const result = evaluate(healthyFleet());
    expect(result.findings.filter((f) => f.kind === "fallback")).toEqual([]);
  });

  it("stays quiet below the bar: one bad turn self-heals on the next text", () => {
    const result = evaluate(healthyFleet(), [], minutesBefore(60 * 24 * 30), null, null, [
      fb("http_error")
    ]);
    expect(result.findings.filter((f) => f.kind === "fallback")).toEqual([]);
  });

  it("pages at the bar, naming the reasons and the affected businesses", () => {
    const rows = [fb("http_error"), fb("request_failed", "biz-2")];
    expect(rows.length).toBe(OWNER_FALLBACK_PAGE_AT);
    const result = evaluate(healthyFleet(), [], minutesBefore(60 * 24 * 30), null, null, rows);
    const finding = result.findings.find((f) => f.kind === "fallback");
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain("2 owner turn(s) fell back");
    expect(finding!.detail).toContain("http_error x1");
    expect(finding!.detail).toContain("request_failed x1");
    expect(finding!.detail).toContain("biz-1");
    expect(finding!.detail).toContain("biz-2");
    // The action has to be actionable, not just descriptive.
    expect(finding!.action).toContain("owner-operator-fallback-report");
  });

  // The whole point of the reason vocabulary: a spend cap doing its job and a
  // deployment missing its token must not read as the platform breaking.
  it("never pages on deliberate or config reasons, however many", () => {
    const rows = [
      fb("over_cap"),
      fb("over_cap"),
      fb("over_cap"),
      fb("not_configured"),
      fb("disabled")
    ];
    const result = evaluate(healthyFleet(), [], minutesBefore(60 * 24 * 30), null, null, rows);
    expect(result.findings.filter((f) => f.kind === "fallback")).toEqual([]);
  });

  it("still counts the quiet reasons into the detail when something else pages", () => {
    const rows = [fb("http_error"), fb("request_failed"), fb("over_cap"), fb("not_configured")];
    const result = evaluate(healthyFleet(), [], minutesBefore(60 * 24 * 30), null, null, rows);
    const finding = result.findings.find((f) => f.kind === "fallback");
    // Pages on the 2 failed, but "3 more were the cap and the config" is
    // context the operator wants in the same sentence.
    expect(finding!.detail).toContain("2 owner turn(s) fell back");
    expect(finding!.detail).toContain("over_cap x1 (deliberate degrade)");
    expect(finding!.detail).toContain("not_configured x1 (config)");
  });

  // An unrecognized reason is either a worker ahead of this reader or a
  // corrupted payload. Both deserve a look, so it counts toward the alarm.
  it("treats an unknown reason as a failure rather than dropping it", () => {
    const rows = [fb("teleported_sideways"), fb("also_new")];
    const result = evaluate(healthyFleet(), [], minutesBefore(60 * 24 * 30), null, null, rows);
    expect(result.findings.some((f) => f.kind === "fallback")).toBe(true);
  });

  it("omits the affected line when no row carried a business", () => {
    // A telemetry payload without business_id is possible, and the finding
    // must still read as a sentence rather than trailing an empty label.
    const rows: OwnerFallbackRow[] = [
      { reason: "http_error", created_at: minutesBefore(10), business_id: null },
      { reason: "bad_payload", created_at: minutesBefore(10), business_id: null }
    ];
    const result = evaluate(healthyFleet(), [], minutesBefore(60 * 24 * 30), null, null, rows);
    const finding = result.findings.find((f) => f.kind === "fallback");
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain("2 owner turn(s) fell back");
    expect(finding!.detail).not.toContain("affected:");
  });

  it("says so when the read was capped, so the count reads as a floor", () => {
    const rows = Array.from({ length: OWNER_FALLBACK_ROW_CAP }, () => fb("http_error"));
    const result = evaluate(
      healthyFleet(),
      [],
      minutesBefore(60 * 24 * 30),
      null,
      null,
      rows,
      true
    );
    const finding = result.findings.find((f) => f.kind === "fallback");
    expect(finding!.detail).toContain(`read capped at ${OWNER_FALLBACK_ROW_CAP} rows`);
    expect(finding!.detail).toContain("floor");
  });

  it("does not disturb the sweep verdict: a healthy fleet stays healthy", () => {
    const result = evaluate(healthyFleet(), [], minutesBefore(60 * 24 * 30), null, null, [
      fb("http_error"),
      fb("request_failed")
    ]);
    expect(result.findings.filter((f) => f.kind !== "fallback")).toEqual([]);
    expect(result.healthy.length).toBe(Object.keys(SWEEP_EXPECTATIONS).length);
  });
});
