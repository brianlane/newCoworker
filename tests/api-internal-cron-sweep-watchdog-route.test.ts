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
  rpc?: QueryResult;
  insert?: { error: { message: string } | null };
}) {
  const neq = vi.fn();
  const results = [
    opts.runs ?? { data: [], error: null },
    opts.oldest ?? { data: [], error: null }
  ];
  let call = 0;

  function chain(): Record<string, unknown> {
    const result = results[Math.min(call++, results.length - 1)];
    const self: Record<string, unknown> = {};
    for (const m of ["select", "gte", "order", "limit"]) {
      self[m] = vi.fn().mockReturnValue(self);
    }
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
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({
    from: vi.fn(() => chain()),
    rpc: vi.fn().mockResolvedValue(opts.rpc ?? { data: [], error: null })
  } as unknown as Awaited<ReturnType<typeof createSupabaseServiceClient>>);
  return { neq, insert };
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

  it("counts only cron-sourced rows, so webhook kicks cannot stand in for a dead cron", async () => {
    const { neq } = mockSupabase({ runs: { data: healthyRows(), error: null } });
    await POST(makeRequest());
    // Applied to BOTH ledger reads: the window and the oldest-row probe.
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

  it("reports HTTP-layer failures that no sweep could report about itself", async () => {
    mockSupabase({
      runs: { data: healthyRows(), error: null },
      oldest: { data: [{ finished_at: new Date(Date.now() - 86_400_000 * 30).toISOString() }], error: null },
      rpc: {
        data: [
          {
            id: 1,
            status_code: null,
            timed_out: true,
            error_msg: null,
            created: "2026-08-08T02:50:01Z"
          }
        ],
        error: null
      }
    });
    const body = await (await POST(makeRequest())).json();
    expect(body.data.httpFailures).toBe(1);
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
