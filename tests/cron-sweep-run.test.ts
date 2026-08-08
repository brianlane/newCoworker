import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  CRON_SOURCE_HEADER,
  DIRECT_SOURCE,
  SWEEP_ERRORS_MAX,
  SWEEP_ERROR_TEXT_MAX,
  buildSweepRunRow,
  extractSweepErrors,
  extractSweepSummary,
  parseSweepBody,
  recordSweepRun,
  withSweepRun
} from "@/lib/cron/sweep-run";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { errorResponse, successResponse } from "@/lib/api-response";

const START = Date.parse("2026-08-08T02:50:00.000Z");

/** Captures what was inserted so assertions read the real row, not a fixture. */
function mockInsert(result: { error: { message: string } | null } = { error: null }) {
  const insert = vi.fn().mockResolvedValue(result);
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({
    from: vi.fn().mockReturnValue({ insert })
  } as unknown as Awaited<ReturnType<typeof createSupabaseServiceClient>>);
  return insert;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extractSweepErrors", () => {
  it("reads the errors array the sweeps actually return", () => {
    expect(extractSweepErrors({ scanned: 3, errors: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("reads failures too, since the VPS sweeps use that key instead", () => {
    expect(extractSweepErrors({ failures: ["boom"] })).toEqual(["boom"]);
  });

  it("concatenates both when a sweep carries each for a different purpose", () => {
    expect(extractSweepErrors({ errors: ["a"], failures: ["b"] })).toEqual(["a", "b"]);
  });

  it("treats a clean run as no errors", () => {
    expect(extractSweepErrors({ scanned: 0, errors: [] })).toEqual([]);
  });

  it("ignores non-object, null, and array bodies rather than throwing", () => {
    expect(extractSweepErrors("nope")).toEqual([]);
    expect(extractSweepErrors(null)).toEqual([]);
    expect(extractSweepErrors([1, 2])).toEqual([]);
  });

  it("ignores an errors key that is not an array", () => {
    expect(extractSweepErrors({ errors: "one big string" })).toEqual([]);
  });
});

describe("extractSweepSummary", () => {
  it("keeps the counts and drops the error lists and self-timing", () => {
    expect(
      extractSweepSummary({
        businesses: 8,
        snapshots: 24,
        errors: ["x"],
        failures: ["y"],
        durationMs: 2853
      })
    ).toEqual({ businesses: 8, snapshots: 24 });
  });

  it("ignores non-object bodies", () => {
    expect(extractSweepSummary(null)).toEqual({});
    expect(extractSweepSummary([1])).toEqual({});
  });
});

describe("buildSweepRunRow", () => {
  it("derives finished_at from startedAt plus the measured duration", () => {
    const row = buildSweepRunRow({
      sweep: "analytics-snapshot-sweep",
      startedAt: START,
      durationMs: 2853,
      ok: true,
      result: { businesses: 8, snapshots: 24, errors: [], durationMs: 2853 }
    });
    expect(row).toEqual({
      sweep: "analytics-snapshot-sweep",
      started_at: "2026-08-08T02:50:00.000Z",
      finished_at: "2026-08-08T02:50:02.853Z",
      duration_ms: 2853,
      ok: true,
      error_count: 0,
      errors: [],
      summary: { businesses: 8, snapshots: 24 },
      source: "direct"
    });
  });

  it("records the silent-200 case: ok true with a populated errors array", () => {
    const row = buildSweepRunRow({
      sweep: "data-retention-sweep",
      startedAt: START,
      durationMs: 143,
      ok: true,
      result: { targets: 4, pruned: 0, errors: ["tenant a failed", "tenant b failed"] }
    });
    expect(row.ok).toBe(true);
    expect(row.error_count).toBe(2);
    expect(row.errors).toEqual(["tenant a failed", "tenant b failed"]);
  });

  it("caps the stored list but keeps the true count, so a cap never under-reports", () => {
    const many = Array.from({ length: SWEEP_ERRORS_MAX + 10 }, (_, i) => `err ${i}`);
    const row = buildSweepRunRow({
      sweep: "outreach-sweep",
      startedAt: START,
      durationMs: 10,
      ok: true,
      result: { errors: many }
    });
    expect(row.error_count).toBe(SWEEP_ERRORS_MAX + 10);
    expect(row.errors).toHaveLength(SWEEP_ERRORS_MAX);
    expect(row.errors[0]).toBe("err 0");
  });

  it("truncates a single huge error entry", () => {
    const row = buildSweepRunRow({
      sweep: "outreach-sweep",
      startedAt: START,
      durationMs: 10,
      ok: true,
      result: { errors: ["x".repeat(SWEEP_ERROR_TEXT_MAX + 100)] }
    });
    expect(row.errors[0]).toHaveLength(SWEEP_ERROR_TEXT_MAX);
  });

  it("renders Error, object, and unserialisable error entries as text", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const row = buildSweepRunRow({
      sweep: "outreach-sweep",
      startedAt: START,
      durationMs: 10,
      ok: true,
      result: { errors: [new Error("blew up"), { code: 42 }, circular] }
    });
    expect(row.errors[0]).toBe("blew up");
    expect(row.errors[1]).toBe('{"code":42}');
    expect(row.errors[2]).toBe("[object Object]");
  });

  it("records a thrown sweep as ok false with the throw as its only error", () => {
    const row = buildSweepRunRow({
      sweep: "subscription-grace-sweep",
      startedAt: START,
      durationMs: 50,
      ok: false,
      error: new Error("connection reset")
    });
    expect(row.ok).toBe(false);
    expect(row.error_count).toBe(1);
    expect(row.errors).toEqual(["connection reset"]);
    // No counts are trustworthy from a run that threw partway through.
    expect(row.summary).toEqual({});
  });

  it("still records a failure whose thrown value was never captured", () => {
    const row = buildSweepRunRow({
      sweep: "subscription-grace-sweep",
      startedAt: START,
      durationMs: 50,
      ok: false
    });
    expect(row.errors).toEqual(["sweep threw a non-Error value"]);
  });
});

describe("parseSweepBody", () => {
  it("reads the successResponse envelope every internal route uses", async () => {
    const res = successResponse({ businesses: 8, errors: [] });
    expect(parseSweepBody(res.status, await res.text())).toEqual({
      ok: true,
      result: { businesses: 8, errors: [] },
      error: undefined
    });
  });

  it("reads the errorResponse envelope as a failure carrying its error", async () => {
    const res = errorResponse("INTERNAL_SERVER_ERROR", "Sweep failed", 500);
    const parsed = parseSweepBody(res.status, await res.text());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toEqual({ code: "INTERNAL_SERVER_ERROR", message: "Sweep failed" });
  });

  it("does not believe an ok:true envelope carrying a 5xx status", () => {
    const parsed = parseSweepBody(500, JSON.stringify({ ok: true, data: { x: 1 } }));
    expect(parsed.ok).toBe(false);
  });

  it("does not believe a 200 whose envelope says ok:false", () => {
    const parsed = parseSweepBody(200, JSON.stringify({ ok: false, error: { message: "nope" } }));
    expect(parsed.ok).toBe(false);
  });

  it("falls back on an unparseable body rather than losing the run", () => {
    expect(parseSweepBody(200, "<html>gateway</html>")).toEqual({ ok: true, error: undefined });
    expect(parseSweepBody(502, "<html>gateway</html>")).toEqual({
      ok: false,
      error: "<html>gateway</html>"
    });
  });

  it("handles a JSON body that is not an object", () => {
    expect(parseSweepBody(200, "[1,2]")).toEqual({ ok: true });
    expect(parseSweepBody(200, "null")).toEqual({ ok: true });
  });

  it("falls back to the raw text when a failure envelope carries no error field", () => {
    expect(parseSweepBody(500, JSON.stringify({ ok: false })).error).toBe('{"ok":false}');
  });
});

describe("recordSweepRun", () => {
  it("inserts the built row into cron_sweep_runs", async () => {
    const insert = mockInsert();
    await recordSweepRun({
      sweep: "document-expiration-sweep",
      startedAt: START,
      durationMs: 120,
      ok: true,
      result: { scanned: 0, errors: [] }
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        sweep: "document-expiration-sweep",
        duration_ms: 120,
        ok: true,
        error_count: 0
      })
    );
  });

  it("logs and swallows an insert error, so bookkeeping cannot fail the sweep", async () => {
    mockInsert({ error: { message: "permission denied" } });
    await expect(
      recordSweepRun({ sweep: "s", startedAt: START, durationMs: 1, ok: true, result: {} })
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "recordSweepRun insert failed",
      expect.objectContaining({ error: "permission denied" })
    );
  });

  it("logs and swallows a thrown client, for the same reason", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    await expect(
      recordSweepRun({ sweep: "s", startedAt: START, durationMs: 1, ok: true, result: {} })
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "recordSweepRun threw",
      expect.objectContaining({ error: "no env" })
    );
  });

  it("stringifies a non-Error throw from the client", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValue("nope");
    await recordSweepRun({ sweep: "s", startedAt: START, durationMs: 1, ok: true, result: {} });
    expect(logger.error).toHaveBeenCalledWith(
      "recordSweepRun threw",
      expect.objectContaining({ error: "nope" })
    );
  });
});

describe("withSweepRun", () => {
  const request = new Request("https://app.test/api/internal/x", { method: "POST" });

  it("returns the handler's response untouched and still readable", async () => {
    mockInsert();
    const wrapped = withSweepRun("analytics-snapshot-sweep", async () =>
      successResponse({ businesses: 8, errors: [], durationMs: 2853 })
    );
    const res = await wrapped(request);
    expect(res.status).toBe(200);
    // The clone must not have consumed the body the caller still needs.
    await expect(res.json()).resolves.toEqual({
      ok: true,
      data: { businesses: 8, errors: [], durationMs: 2853 }
    });
  });

  it("records a successful run with the sweep's own counts", async () => {
    const insert = mockInsert();
    const wrapped = withSweepRun("analytics-snapshot-sweep", async () =>
      successResponse({ businesses: 8, snapshots: 24, errors: [] })
    );
    await wrapped(request);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        sweep: "analytics-snapshot-sweep",
        ok: true,
        error_count: 0,
        summary: { businesses: 8, snapshots: 24 }
      })
    );
  });

  it("records a 500 answer as a failed run", async () => {
    const insert = mockInsert();
    const wrapped = withSweepRun("data-retention-sweep", async () =>
      errorResponse("INTERNAL_SERVER_ERROR", "Sweep failed", 500)
    );
    await wrapped(request);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ sweep: "data-retention-sweep", ok: false, error_count: 1 })
    );
  });

  it("does NOT record a rejected cron bearer, so probes cannot fabricate runs", async () => {
    const insert = mockInsert();
    for (const status of [401, 403]) {
      const wrapped = withSweepRun("subscription-grace-sweep", async () =>
        errorResponse(status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", "Invalid cron bearer", status)
      );
      const res = await wrapped(request);
      expect(res.status).toBe(status);
    }
    expect(insert).not.toHaveBeenCalled();
  });

  it("records a thrown handler and rethrows it unchanged", async () => {
    const insert = mockInsert();
    const boom = new Error("unhandled");
    const wrapped = withSweepRun("outreach-sweep", async () => {
      throw boom;
    });
    await expect(wrapped(request)).rejects.toBe(boom);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ sweep: "outreach-sweep", ok: false, errors: ["unhandled"] })
    );
  });

  it("still records the run when the response body cannot be read", async () => {
    const insert = mockInsert();
    const unreadable = new Response("x", { status: 200 });
    vi.spyOn(unreadable, "clone").mockImplementation(() => {
      throw new Error("stream already locked");
    });
    const wrapped = withSweepRun("meta-capi-drain", async () => unreadable);
    await wrapped(request);
    expect(logger.warn).toHaveBeenCalledWith(
      "withSweepRun could not read the sweep response body",
      expect.objectContaining({ sweep: "meta-capi-drain" })
    );
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ sweep: "meta-capi-drain" }));
  });

  it("stringifies a non-Error thrown while reading the body", async () => {
    mockInsert();
    const unreadable = new Response("x", { status: 200 });
    vi.spyOn(unreadable, "clone").mockImplementation(() => {
      throw "locked";
    });
    const wrapped = withSweepRun("meta-capi-drain", async () => unreadable);
    await wrapped(request);
    expect(logger.warn).toHaveBeenCalledWith(
      "withSweepRun could not read the sweep response body",
      expect.objectContaining({ error: "locked" })
    );
  });

  it("measures a duration that reflects how long the handler actually took", async () => {
    const insert = mockInsert();
    const wrapped = withSweepRun("blog-publish-sweep", async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return successResponse({ published: 1 });
    });
    await wrapped(request);
    const row = insert.mock.calls[0][0] as { duration_ms: number };
    expect(row.duration_ms).toBeGreaterThanOrEqual(20);
  });
});

/**
 * The cron bearer is not exclusive to pg_cron: the Meta webhook kicks
 * /api/internal/messenger-worker with it on every inbound message. Without a
 * recorded source, that traffic would keep the ledger looking alive while
 * the per-minute cron job was dead.
 */
describe("run attribution", () => {
  const cronRequest = (job: string) =>
    new Request("https://app.test/api/internal/messenger-worker", {
      method: "POST",
      headers: { [CRON_SOURCE_HEADER]: job }
    });

  it("records the bridge name when the Edge cron bridge stamped the request", async () => {
    const insert = mockInsert();
    const wrapped = withSweepRun("messenger-worker", async () => successResponse({ claimed: 0 }));
    await wrapped(cronRequest("messenger-jobs-sweep"));
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ sweep: "messenger-worker", source: "messenger-jobs-sweep" })
    );
  });

  it("records the Meta webhook's unstamped kick as direct, not as a cron run", async () => {
    const insert = mockInsert();
    const wrapped = withSweepRun("messenger-worker", async () => successResponse({ claimed: 1 }));
    await wrapped(new Request("https://app.test/api/internal/messenger-worker", { method: "POST" }));
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ source: DIRECT_SOURCE }));
  });

  it("treats a blank header as direct rather than as an empty-named cron job", async () => {
    const insert = mockInsert();
    const wrapped = withSweepRun("messenger-worker", async () => successResponse({ claimed: 0 }));
    await wrapped(cronRequest("   "));
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ source: DIRECT_SOURCE }));
  });

  it("keeps the source on a thrown run too", async () => {
    const insert = mockInsert();
    const wrapped = withSweepRun("messenger-worker", async () => {
      throw new Error("boom");
    });
    await expect(wrapped(cronRequest("messenger-jobs-sweep"))).rejects.toThrow("boom");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, source: "messenger-jobs-sweep" })
    );
  });

  it("defaults to direct when the builder is called without a source", () => {
    expect(
      buildSweepRunRow({ sweep: "s", startedAt: START, durationMs: 1, ok: true, result: {} }).source
    ).toBe(DIRECT_SOURCE);
  });
});
