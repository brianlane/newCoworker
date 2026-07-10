import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => defaultClientSpy(...a)
}));

const processWebhookFlowEvent = vi.fn();
vi.mock("@/lib/ai-flows/webhook-events", () => ({
  processWebhookFlowEvent: (...a: unknown[]) => processWebhookFlowEvent(...a)
}));

const recordSystemLog = vi.fn();
vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: (...a: unknown[]) => recordSystemLog(...a)
}));

import {
  DEFAULT_BACKLOG_SOURCE,
  MAX_BACKLOG_ROWS,
  importLeadBacklog,
  parseLeadBacklog
} from "@/lib/ai-flows/lead-backlog";

const DB = { fake: "db" };
const BASE_MS = Date.parse("2026-07-10T20:00:00.000Z");

/** processWebhookFlowEvent result shorthands. */
const ENQUEUED = { enqueued: 1, flowsEvaluated: 2, flowsMatched: 1 };
const DUPLICATE = { enqueued: 0, flowsEvaluated: 2, flowsMatched: 1 };
const NO_MATCH = { enqueued: 0, flowsEvaluated: 2, flowsMatched: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(BASE_MS);
  processWebhookFlowEvent.mockResolvedValue(ENQUEUED);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseLeadBacklog", () => {
  it("parses a sheet into normalized header-keyed rows", () => {
    const res = parseLeadBacklog("Full Name,Phone Number\nJane,+16025551234\nBob,+16025555678");
    expect(res).toEqual({
      ok: true,
      headers: ["full_name", "phone_number"],
      rows: [
        { full_name: "Jane", phone_number: "+16025551234" },
        { full_name: "Bob", phone_number: "+16025555678" }
      ]
    });
  });

  it("surfaces a structural CSV error", () => {
    const res = parseLeadBacklog('name\n"broken');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/quote/i);
  });

  it("rejects a header-only sheet", () => {
    const res = parseLeadBacklog("name,phone\n");
    expect(res).toEqual({ ok: false, error: "The sheet has a header but no lead rows." });
  });

  it("rejects a sheet over the row cap", () => {
    const csv = ["name", ...Array.from({ length: MAX_BACKLOG_ROWS + 1 }, (_, i) => `lead-${i}`)].join(
      "\n"
    );
    const res = parseLeadBacklog(csv);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(`limit is ${MAX_BACKLOG_ROWS}`);
  });
});

describe("importLeadBacklog", () => {
  it("sends each row as a webhook event: empty cells dropped, default source, drip staggered", async () => {
    const rows = [
      { full_name: "Jane", phone: "+16025551234", notes: "" },
      { full_name: "Bob", phone: "+16025555678", notes: "warm" }
    ];
    const summary = await importLeadBacklog("biz-1", rows, {}, DB as never);

    expect(processWebhookFlowEvent).toHaveBeenNthCalledWith(
      1,
      "biz-1",
      {
        source: DEFAULT_BACKLOG_SOURCE,
        data: { full_name: "Jane", phone: "+16025551234" },
        eventId: undefined
      },
      DB,
      undefined
    );
    // Row 2 releases one default interval (60s) after row 1.
    expect(processWebhookFlowEvent).toHaveBeenNthCalledWith(
      2,
      "biz-1",
      expect.objectContaining({ data: { full_name: "Bob", phone: "+16025555678", notes: "warm" } }),
      DB,
      { earliestClaimAt: new Date(BASE_MS + 60_000).toISOString() }
    );
    expect(summary).toEqual({
      totalRows: 2,
      enqueued: 2,
      duplicates: 0,
      unmatched: 0,
      skipped: 0,
      flowsEvaluated: 2,
      rows: [
        { row: 2, status: "enqueued" },
        { row: 3, status: "enqueued", earliestClaimAt: new Date(BASE_MS + 60_000).toISOString() }
      ]
    });
  });

  it("namespaces the row's explicit id column by source, preferring event_id > lead_id > id", async () => {
    const rows: Record<string, string>[] = [
      { event_id: "E-1", lead_id: "L-1", id: "1", name: "a" },
      { lead_id: " L-2 ", name: "b" },
      { id: "3", name: "c" }
    ];
    await importLeadBacklog("biz-1", rows, { source: "  my_sheet  " }, DB as never);
    const eventIds = processWebhookFlowEvent.mock.calls.map((c) => (c[1] as { eventId?: string }).eventId);
    expect(eventIds).toEqual(["my_sheet:E-1", "my_sheet:L-2", "my_sheet:3"]);
    expect(processWebhookFlowEvent.mock.calls[0][1]).toMatchObject({ source: "my_sheet" });
  });

  it("bounds an over-long source label and falls back on a blank one", async () => {
    await importLeadBacklog("biz-1", [{ a: "x" }], { source: `  ${"s".repeat(200)}` }, DB as never);
    expect((processWebhookFlowEvent.mock.calls[0][1] as { source: string }).source).toBe(
      "s".repeat(120)
    );
    await importLeadBacklog("biz-1", [{ a: "x" }], { source: "   " }, DB as never);
    expect((processWebhookFlowEvent.mock.calls[1][1] as { source: string }).source).toBe(
      DEFAULT_BACKLOG_SOURCE
    );
  });

  it("clamps the drip interval (floor, min 0, max 3600) and treats non-finite as the default", async () => {
    const rows = [{ a: "1" }, { a: "2" }];
    await importLeadBacklog("biz-1", rows, { dripIntervalSeconds: 999999 }, DB as never);
    expect(processWebhookFlowEvent.mock.calls[1][3]).toEqual({
      earliestClaimAt: new Date(BASE_MS + 3600_000).toISOString()
    });

    processWebhookFlowEvent.mockClear();
    await importLeadBacklog("biz-1", rows, { dripIntervalSeconds: -5 }, DB as never);
    // Clamped to 0 = all immediate.
    expect(processWebhookFlowEvent.mock.calls[1][3]).toBeUndefined();

    processWebhookFlowEvent.mockClear();
    await importLeadBacklog("biz-1", rows, { dripIntervalSeconds: Number.NaN }, DB as never);
    expect(processWebhookFlowEvent.mock.calls[1][3]).toEqual({
      earliestClaimAt: new Date(BASE_MS + 60_000).toISOString()
    });

    processWebhookFlowEvent.mockClear();
    await importLeadBacklog("biz-1", rows, { dripIntervalSeconds: 90.9 }, DB as never);
    expect(processWebhookFlowEvent.mock.calls[1][3]).toEqual({
      earliestClaimAt: new Date(BASE_MS + 90_000).toISOString()
    });
  });

  it("classifies duplicate and unmatched rows without stopping the rest", async () => {
    processWebhookFlowEvent
      .mockResolvedValueOnce(DUPLICATE)
      .mockResolvedValueOnce(NO_MATCH)
      .mockResolvedValueOnce(ENQUEUED);
    const summary = await importLeadBacklog(
      "biz-1",
      [{ a: "1" }, { a: "2" }, { a: "3" }],
      { dripIntervalSeconds: 0 },
      DB as never
    );
    expect(summary.enqueued).toBe(1);
    expect(summary.duplicates).toBe(1);
    expect(summary.unmatched).toBe(1);
    expect(summary.rows.map((r) => r.status)).toEqual(["duplicate", "no_match", "enqueued"]);
  });

  it("skips all-empty rows without consuming a drip slot", async () => {
    const summary = await importLeadBacklog(
      "biz-1",
      [{ a: "1", b: "" }, { a: "", b: "" }, { a: "3" }],
      {},
      DB as never
    );
    expect(processWebhookFlowEvent).toHaveBeenCalledTimes(2);
    // The row AFTER the skip still gets slot 1 (base + 60s), not slot 2.
    expect(processWebhookFlowEvent.mock.calls[1][3]).toEqual({
      earliestClaimAt: new Date(BASE_MS + 60_000).toISOString()
    });
    expect(summary.skipped).toBe(1);
    expect(summary.rows).toEqual([
      { row: 2, status: "enqueued" },
      { row: 3, status: "skipped" },
      { row: 4, status: "enqueued", earliestClaimAt: new Date(BASE_MS + 60_000).toISOString() }
    ]);
  });

  it("records one summary system log for the import", async () => {
    await importLeadBacklog("biz-1", [{ a: "1" }], { source: "sheet" }, DB as never);
    expect(recordSystemLog).toHaveBeenCalledTimes(1);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        source: "aiflow",
        event: "lead_backlog_import",
        payload: expect.objectContaining({
          source_label: "sheet",
          total_rows: 1,
          enqueued: 1,
          duplicates: 0,
          unmatched: 0,
          skipped: 0,
          flows_evaluated: 2
        })
      }),
      DB
    );
  });

  it("uses the default service client when none is injected", async () => {
    defaultClientSpy.mockResolvedValueOnce(DB);
    await importLeadBacklog("biz-1", [{ a: "1" }]);
    expect(defaultClientSpy).toHaveBeenCalledTimes(1);
    expect(processWebhookFlowEvent).toHaveBeenCalledWith(
      "biz-1",
      expect.anything(),
      DB,
      undefined
    );
  });
});
