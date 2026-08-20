import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({
  assertCronAuth: vi.fn()
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/email/ops-notify", () => ({
  sendOpsCronSweepHealthEmail: vi.fn(async () => true)
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { POST } from "@/app/api/internal/cron-sweep-watchdog/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { sendOpsCronSweepHealthEmail } from "@/lib/email/ops-notify";
import { SWEEP_EXPECTATIONS } from "@/lib/cron/sweep-watchdog";

type QueryResult = { data: unknown; error: { message: string } | null };

/**
 * Two reads hit cron_sweep_runs (the window, then the ledger's oldest row)
 * and are served in call order; the RPC is separate. Also captures the
 * filters applied, so the tests can assert the route actually excludes
 * direct runs rather than just trusting the query text.
 */
function mockSupabase(opts: {
  runs?: QueryResult;
  oldest?: QueryResult;
  prevSummary?: QueryResult;
  rpc?: QueryResult;
  insert?: { error: { message: string } | null };
}) {
  const neq = vi.fn();
  const gte = vi.fn();
  // Chained table reads in route order: the oldest-row probe, then
  // yesterday's watchdog summary (the grace memory).
  const results = [
    opts.oldest ?? { data: [], error: null },
    opts.prevSummary ?? { data: [], error: null }
  ];
  let call = 0;

  function chain(): Record<string, unknown> {
    const result = results[Math.min(call++, results.length - 1)];
    const self: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit", "eq"]) {
      self[m] = vi.fn().mockReturnValue(self);
    }
    self.gte = vi.fn((...args: unknown[]) => {
      gte(...args);
      return self;
    });
    self.neq = vi.fn((...args: unknown[]) => {
      neq(...args);
      return self;
    });
    self.then = (resolve: (v: QueryResult) => unknown) => Promise.resolve(result).then(resolve);
    // recordSweepRun writes to the SAME table the watchdog reads, so the
    // chain has to serve the insert too.
    self.insert = insert;
    return self;
  }

  const insert = vi.fn().mockResolvedValue(opts.insert ?? { error: null });
  // The run window is served by the bounded evidence RPC, never a table
  // select: PostgREST caps an unlimited select at 1,000 rows, and the fleet
  // writes ~8,800 cron rows per lookback day, so a windowed select silently
  // truncates to ~3 hours and every older daily sweep reads as "stopped"
  // (the 2026-08-10 nine-problem false alarm).
  const rpc = vi.fn((name: string) => {
    if (name === "cron_sweep_run_evidence") {
      return Promise.resolve(opts.runs ?? { data: [], error: null });
    }
    return Promise.resolve(opts.rpc ?? { data: [], error: null });
  });
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({
    from: vi.fn(() => chain()),
    rpc
  } as unknown as Awaited<ReturnType<typeof createSupabaseServiceClient>>);
  return { neq, gte, insert, rpc };
}

function makeRequest(): Request {
  return new Request("http://localhost/api/internal/cron-sweep-watchdog", {
    method: "POST",
    headers: { Authorization: "Bearer secret", "x-cron-job": "cron-sweep-watchdog" }
  });
}

/** A recent healthy run for every expected sweep. */
function healthyRows() {
  const finished = new Date(Date.now() - 60_000).toISOString();
  return Object.keys(SWEEP_EXPECTATIONS).map((sweep) => ({
    sweep,
    finished_at: finished,
    duration_ms: 1000,
    ok: true,
    error_count: 0,
    errors: []
  }));
}

describe("api/internal/cron-sweep-watchdog route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertCronAuth).mockReturnValue(true);
    vi.mocked(sendOpsCronSweepHealthEmail).mockResolvedValue(true);
  });

  it("rejects bad cron bearers", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    mockSupabase({});
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(sendOpsCronSweepHealthEmail).not.toHaveBeenCalled();
  });

  it("stays silent when the whole fleet is healthy", async () => {
    mockSupabase({
      runs: { data: healthyRows(), error: null },
      oldest: { data: [{ finished_at: new Date(Date.now() - 86_400_000 * 30).toISOString() }], error: null }
    });
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.findings).toBe(0);
    expect(body.data.emailed).toBe(false);
    expect(sendOpsCronSweepHealthEmail).not.toHaveBeenCalled();
  });

  it("emails the operator when a sweep has stopped", async () => {
    mockSupabase({
      runs: { data: healthyRows().filter((r) => r.sweep !== "subscription-grace-sweep"), error: null },
      oldest: { data: [{ finished_at: new Date(Date.now() - 86_400_000 * 30).toISOString() }], error: null }
    });
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.data.findings).toBeGreaterThan(0);
    expect(body.data.byKind.missing).toBe(1);
    expect(body.data.emailed).toBe(true);
    expect(sendOpsCronSweepHealthEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        findings: expect.arrayContaining([
          expect.objectContaining({ sweep: "subscription-grace-sweep", kind: "missing" })
        ])
      })
    );
  });

  it("reads the run window through the bounded evidence RPC, never a raw select", async () => {
    const { gte, rpc } = mockSupabase({ runs: { data: healthyRows(), error: null } });
    await POST(makeRequest());
    expect(rpc).toHaveBeenCalledWith("cron_sweep_run_evidence", { since_minutes: 11_520 });
    // No windowed table read: gte() was the old unbounded select's filter.
    expect(gte).not.toHaveBeenCalled();
  });

  it("does not email for a lone HTTP anomaly, but records it as suppressed", async () => {
    mockSupabase({
      runs: { data: healthyRows(), error: null },
      oldest: { data: [{ finished_at: new Date(Date.now() - 86_400_000 * 30).toISOString() }], error: null },
      rpc: {
        data: [{ id: 1, status_code: 502, timed_out: false, error_msg: null, created: new Date().toISOString() }],
        error: null
      }
    });
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.data.findings).toBe(0);
    expect(body.data.suppressedHttp).toBe(1);
    expect(body.data.emailed).toBe(false);
    expect(sendOpsCronSweepHealthEmail).not.toHaveBeenCalled();
  });

  it("graces a first-night absentee when yesterday's memory clears it, and remembers it", async () => {
    mockSupabase({
      runs: { data: healthyRows().filter((r) => r.sweep !== "subscription-grace-sweep"), error: null },
      oldest: { data: [{ finished_at: new Date(Date.now() - 86_400_000 * 30).toISOString() }], error: null },
      prevSummary: { data: [{ summary: { missing: [] } }], error: null }
    });
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.data.findings).toBe(0);
    expect(body.data.graced).toEqual(["subscription-grace-sweep"]);
    // Tomorrow's memory: still absent tomorrow means page.
    expect(body.data.missing).toEqual(["subscription-grace-sweep"]);
    expect(sendOpsCronSweepHealthEmail).not.toHaveBeenCalled();
  });

  it("pages on night two, when yesterday's memory already lists the absentee", async () => {
    mockSupabase({
      runs: { data: healthyRows().filter((r) => r.sweep !== "subscription-grace-sweep"), error: null },
      oldest: { data: [{ finished_at: new Date(Date.now() - 86_400_000 * 30).toISOString() }], error: null },
      prevSummary: { data: [{ summary: { missing: ["subscription-grace-sweep"] } }], error: null }
    });
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.data.byKind.missing).toBe(1);
    expect(body.data.emailed).toBe(true);
    expect(sendOpsCronSweepHealthEmail).toHaveBeenCalled();
  });

  it("fails open when yesterday's summary is unreadable: no grace, page", async () => {
    mockSupabase({
      runs: { data: healthyRows().filter((r) => r.sweep !== "subscription-grace-sweep"), error: null },
      oldest: { data: [{ finished_at: new Date(Date.now() - 86_400_000 * 30).toISOString() }], error: null },
      prevSummary: { data: null, error: { message: "boom" } }
    });
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.data.byKind.missing).toBe(1);
    expect(body.data.emailed).toBe(true);
  });

  it("counts only cron-sourced rows, so webhook kicks cannot stand in for a dead cron", async () => {
    const { neq } = mockSupabase({ runs: { data: healthyRows(), error: null } });
    await POST(makeRequest());
    // The oldest-row probe and the grace-memory read both exclude direct
    // runs client-side; the run window's source filter lives inside
    // cron_sweep_run_evidence (pinned by
    // tests/worker-integration/cron-sweep-run-evidence.itest.ts).
    expect(neq).toHaveBeenCalledTimes(2);
    expect(neq).toHaveBeenCalledWith("source", "direct");
  });

  it("fails loudly when the run ledger cannot be read", async () => {
    mockSupabase({ runs: { data: null, error: { message: "permission denied" } } });
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    expect(sendOpsCronSweepHealthEmail).not.toHaveBeenCalled();
  });

  it("survives a broken HTTP-failure read, since the stopped-sweep alert matters more", async () => {
    mockSupabase({
      runs: { data: healthyRows(), error: null },
      oldest: { data: [{ finished_at: new Date(Date.now() - 86_400_000 * 30).toISOString() }], error: null },
      rpc: { data: null, error: { message: "function does not exist" } }
    });
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.httpReadError).toBe("function does not exist");
    // NOT under "errors": that key is the per-tenant work failure list the
    // recorder counts, so an infrastructure problem there would come back on
    // the next run misclassified as a silent-200.
    expect(body.data.errors).toBeUndefined();
    expect(body.data.byKind.degraded).toBe(1);
    expect(body.data.emailed).toBe(true);
  });

  it("pages an HTTP burst that no sweep could report about itself", async () => {
    // Three anomalies inside an hour: past the pager bar. A lone anomaly is
    // covered by the suppression test above.
    const now = Date.now();
    mockSupabase({
      runs: { data: healthyRows(), error: null },
      oldest: { data: [{ finished_at: new Date(now - 86_400_000 * 30).toISOString() }], error: null },
      rpc: {
        data: [0, 15, 30].map((m, i) => ({
          id: i + 1,
          status_code: null,
          timed_out: true,
          error_msg: null,
          created: new Date(now - m * 60_000).toISOString()
        })),
        error: null
      }
    });
    const body = await (await POST(makeRequest())).json();
    expect(body.data.httpFailures).toBe(3);
    expect(body.data.byKind.burst).toBe(1);
    expect(body.data.suppressedHttp).toBe(0);
    expect(body.data.emailed).toBe(true);
  });

  it("answers 500 when the whole check throws", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
  });

  it("records its own run, like every other sweep", async () => {
    const { insert } = mockSupabase({ runs: { data: healthyRows(), error: null } });
    await POST(makeRequest());
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ sweep: "cron-sweep-watchdog", source: "cron-sweep-watchdog" })
    );
  });
});
