import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALL_SUMMARY_BATCH_LIMIT,
  CALL_SUMMARY_BATCH_PER_BUSINESS,
  CALL_SUMMARY_MAX_ATTEMPTS,
  CALL_SUMMARY_WINDOW_HOURS,
  callSummarySweepTierAllowed,
  processCallSummarySweep,
  type CallSummarySweepSupabase
} from "../supabase/functions/_shared/call_summary_sweep";

type DbResult = { data: unknown; error: { message: string } | null };

function makeSupabase(overrides: { scan?: DbResult; tiers?: DbResult } = {}) {
  const limit = vi.fn(async () => overrides.scan ?? { data: [], error: null });
  const order = vi.fn(() => ({ limit }));
  const gte = vi.fn(() => ({ order }));
  const lt = vi.fn(() => ({ gte }));
  const is = vi.fn(() => ({ lt }));
  const eq = vi.fn(() => ({ is }));
  const inFn = vi.fn(async () => overrides.tiers ?? { data: [], error: null });
  const select = vi.fn(() => ({ eq, in: inFn }));
  const from = vi.fn(() => ({ select }));
  return {
    supabase: { from } as unknown as CallSummarySweepSupabase,
    from,
    select,
    eq,
    is,
    lt,
    gte,
    order,
    limit,
    inFn
  };
}

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, text: vi.fn() }) as unknown as typeof fetch;
}

const baseOpts = {
  platformBaseUrl: "https://app.example.com/",
  platformBearer: "cron-secret",
  nowMs: Date.parse("2026-07-27T12:00:00Z")
};

describe("call summary sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("callSummarySweepTierAllowed gates on standard/enterprise", () => {
    expect(callSummarySweepTierAllowed("standard")).toBe(true);
    expect(callSummarySweepTierAllowed("enterprise")).toBe(true);
    expect(callSummarySweepTierAllowed("starter")).toBe(false);
    expect(callSummarySweepTierAllowed(null)).toBe(false);
    expect(callSummarySweepTierAllowed(undefined)).toBe(false);
  });

  it("throws when the scan query errors", async () => {
    const { supabase } = makeSupabase({ scan: { data: null, error: { message: "db down" } } });
    await expect(
      processCallSummarySweep(supabase, { ...baseOpts, fetchFn: okFetch() })
    ).rejects.toThrow("call_summary_scan: db down");
  });

  it("scans with the eligibility filters and the widened batch net", async () => {
    const m = makeSupabase();
    const result = await processCallSummarySweep(m.supabase, {
      ...baseOpts,
      fetchFn: okFetch()
    });
    expect(result).toEqual({ scanned: 0, dispatched: 0, succeeded: 0, failed: 0, failures: [] });
    expect(m.eq).toHaveBeenCalledWith("status", "completed");
    expect(m.is).toHaveBeenCalledWith("summarized_at", null);
    expect(m.lt).toHaveBeenCalledWith("summary_attempts", CALL_SUMMARY_MAX_ATTEMPTS);
    expect(m.gte).toHaveBeenCalledWith(
      "ended_at",
      new Date(baseOpts.nowMs - CALL_SUMMARY_WINDOW_HOURS * 3_600_000).toISOString()
    );
    expect(m.order).toHaveBeenCalledWith("ended_at", { ascending: false });
    expect(m.limit).toHaveBeenCalledWith(CALL_SUMMARY_BATCH_LIMIT * 4);
    // Empty scan short-circuits before the tier lookup.
    expect(m.inFn).not.toHaveBeenCalled();
  });

  it("treats a non-array scan payload as empty", async () => {
    const { supabase } = makeSupabase({ scan: { data: null, error: null } });
    const result = await processCallSummarySweep(supabase, { ...baseOpts, fetchFn: okFetch() });
    expect(result.scanned).toBe(0);
  });

  it("throws when the tier lookup errors", async () => {
    const { supabase } = makeSupabase({
      scan: { data: [{ id: "t1", business_id: "biz-1" }], error: null },
      tiers: { data: null, error: { message: "tiers down" } }
    });
    await expect(
      processCallSummarySweep(supabase, { ...baseOpts, fetchFn: okFetch() })
    ).rejects.toThrow("call_summary_tiers: tiers down");
  });

  it("dispatches entitled rows and skips starter/unknown tiers (non-array tiers tolerated)", async () => {
    const { supabase, inFn } = makeSupabase({
      scan: {
        data: [
          { id: "t1", business_id: "biz-std" },
          { id: "t2", business_id: "biz-starter" },
          { id: "t3", business_id: "biz-unknown" },
          { id: "t4", business_id: "biz-ent" }
        ],
        error: null
      },
      tiers: {
        data: [
          { id: "biz-std", tier: "standard" },
          { id: "biz-starter", tier: "starter" },
          { id: "biz-ent", tier: "enterprise" }
        ],
        error: null
      }
    });
    const fetchFn = okFetch();
    const result = await processCallSummarySweep(supabase, { ...baseOpts, fetchFn });
    expect(inFn).toHaveBeenCalledWith("id", ["biz-std", "biz-starter", "biz-unknown", "biz-ent"]);
    expect(result).toEqual({ scanned: 4, dispatched: 2, succeeded: 2, failed: 0, failures: [] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledWith("https://app.example.com/api/internal/summarize-call", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer cron-secret"
      },
      body: JSON.stringify({ businessId: "biz-std", transcriptId: "t1", source: "cron_sweep" })
    });
  });

  it("tolerates a non-array tier payload (everything filtered out)", async () => {
    const { supabase } = makeSupabase({
      scan: { data: [{ id: "t1", business_id: "biz-1" }], error: null },
      tiers: { data: null, error: null }
    });
    const fetchFn = okFetch();
    const result = await processCallSummarySweep(supabase, { ...baseOpts, fetchFn });
    expect(result.dispatched).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("caps dispatches per business and stops at the batch limit", async () => {
    const busy = Array.from({ length: CALL_SUMMARY_BATCH_PER_BUSINESS + 2 }, (_, i) => ({
      id: `busy-${i}`,
      business_id: "biz-busy"
    }));
    const others = Array.from({ length: 4 }, (_, i) => ({
      id: `other-${i}`,
      business_id: `biz-${i}`
    }));
    const { supabase } = makeSupabase({
      scan: { data: [...busy, ...others], error: null },
      tiers: {
        data: [
          { id: "biz-busy", tier: "standard" },
          ...others.map((o) => ({ id: o.business_id, tier: "standard" }))
        ],
        error: null
      }
    });
    const fetchFn = okFetch();
    const result = await processCallSummarySweep(supabase, {
      ...baseOpts,
      fetchFn,
      batchLimit: CALL_SUMMARY_BATCH_PER_BUSINESS + 2
    });
    // busy tenant capped at CALL_SUMMARY_BATCH_PER_BUSINESS, then two others
    // fill the batch limit.
    expect(result.dispatched).toBe(CALL_SUMMARY_BATCH_PER_BUSINESS + 2);
    const dispatchedIds = vi
      .mocked(fetchFn)
      .mock.calls.map((c) => (JSON.parse(String(c[1]!.body)) as { transcriptId: string }).transcriptId);
    expect(dispatchedIds.filter((id) => id.startsWith("busy-"))).toHaveLength(
      CALL_SUMMARY_BATCH_PER_BUSINESS
    );
  });

  it("counts non-OK dispatches as failures with the response text", async () => {
    const { supabase } = makeSupabase({
      scan: { data: [{ id: "t1", business_id: "biz-1" }], error: null },
      tiers: { data: [{ id: "biz-1", tier: "standard" }], error: null }
    });
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue("boom")
    }) as unknown as typeof fetch;
    const result = await processCallSummarySweep(supabase, { ...baseOpts, fetchFn });
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([{ transcriptId: "t1", reason: "http_500: boom" }]);
  });

  it("falls back to an empty reason body when the failure text() rejects", async () => {
    const { supabase } = makeSupabase({
      scan: { data: [{ id: "t1", business_id: "biz-1" }], error: null },
      tiers: { data: [{ id: "biz-1", tier: "standard" }], error: null }
    });
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: vi.fn().mockRejectedValue(new Error("no body"))
    }) as unknown as typeof fetch;
    const result = await processCallSummarySweep(supabase, { ...baseOpts, fetchFn });
    expect(result.failures).toEqual([{ transcriptId: "t1", reason: "http_503: " }]);
  });

  it("counts thrown fetches (Error and non-Error) as failures", async () => {
    const { supabase } = makeSupabase({
      scan: {
        data: [
          { id: "t1", business_id: "biz-1" },
          { id: "t2", business_id: "biz-2" }
        ],
        error: null
      },
      tiers: {
        data: [
          { id: "biz-1", tier: "standard" },
          { id: "biz-2", tier: "enterprise" }
        ],
        error: null
      }
    });
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("net down"))
      .mockRejectedValueOnce("string blowup") as unknown as typeof fetch;
    const result = await processCallSummarySweep(supabase, { ...baseOpts, fetchFn });
    expect(result.failed).toBe(2);
    expect(result.failures).toEqual([
      { transcriptId: "t1", reason: "net down" },
      { transcriptId: "t2", reason: "string blowup" }
    ]);
  });

  it("caps the reported failures at 10", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `t${i}`,
      business_id: `biz-${i}`
    }));
    const { supabase } = makeSupabase({
      scan: { data: rows, error: null },
      tiers: { data: rows.map((r) => ({ id: r.business_id, tier: "standard" })), error: null }
    });
    const fetchFn = vi.fn().mockRejectedValue(new Error("down")) as unknown as typeof fetch;
    const result = await processCallSummarySweep(supabase, { ...baseOpts, fetchFn });
    expect(result.failed).toBe(12);
    expect(result.failures).toHaveLength(10);
  });

  it("defaults to global fetch, the default batch limit, and Date.now()", async () => {
    const { supabase, limit } = makeSupabase({
      scan: { data: [{ id: "t1", business_id: "biz-1" }], error: null },
      tiers: { data: [{ id: "biz-1", tier: "standard" }], error: null }
    });
    const globalFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: vi.fn() }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", globalFetch);
    const result = await processCallSummarySweep(supabase, {
      platformBaseUrl: "https://app.example.com",
      platformBearer: "cron-secret"
    });
    expect(result.succeeded).toBe(1);
    expect(globalFetch).toHaveBeenCalledWith(
      "https://app.example.com/api/internal/summarize-call",
      expect.anything()
    );
    expect(limit).toHaveBeenCalledWith(CALL_SUMMARY_BATCH_LIMIT * 4);
  });
});
