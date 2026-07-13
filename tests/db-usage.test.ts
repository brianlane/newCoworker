import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getTodayUsage,
  getCalendarMonthUsageTotals,
  getFleetCalendarMonthUsageTotals,
  getFleetCalendarMonthUsageByBusiness,
  peakConcurrentFromIntervals,
  incrementUsage,
  checkLimitReached
} from "@/lib/db/usage";
import { TIER_LIMITS } from "@/lib/plans/limits";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const TODAY = new Date().toISOString().slice(0, 10);

const MOCK_USAGE = {
  id: "usage-uuid-1",
  business_id: "biz-uuid-1",
  usage_date: TODAY,
  voice_minutes_used: 30,
  sms_sent: 50,
  calls_made: 5,
  peak_concurrent_calls: 1,
  created_at: "2026-03-27T00:00:00Z",
  updated_at: "2026-03-27T00:00:00Z"
};

function mockDb(overrides: Record<string, unknown> = {}) {
  const base = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: MOCK_USAGE, error: null }),
    rpc: vi.fn().mockResolvedValue({ error: null }),
    ...overrides
  };
  return base;
}

/** Supports `getTodayUsage` (.single) and monthly totals (.gte → thenable). */
function mockLimitClient(opts: {
  today?: typeof MOCK_USAGE | null;
  monthRows?: Array<{ sms_sent?: number; calls_made?: number }>;
  monthError?: { message: string };
}) {
  const today = opts.today !== undefined ? opts.today : MOCK_USAGE;
  const monthRows = opts.monthRows ?? [];

  const monthThenable: PromiseLike<{
    data: typeof monthRows | null;
    error: { message: string } | null;
  }> = {
    then(onFulfilled, onRejected) {
      const payload = opts.monthError
        ? { data: null, error: opts.monthError }
        : { data: monthRows, error: null };
      return Promise.resolve(payload).then(onFulfilled, onRejected);
    }
  };

  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.gte = vi.fn(() => monthThenable);
  chain.single = vi.fn(() =>
    Promise.resolve({
      data: today,
      error: today ? null : { message: "no rows" }
    })
  );
  chain.rpc = vi.fn().mockResolvedValue({ error: null });

  return chain;
}

describe("db/usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getTodayUsage", () => {
    it("returns usage row for today", async () => {
      const db = mockDb();
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await getTodayUsage("biz-uuid-1");
      expect(result?.voice_minutes_used).toBe(30);
      expect(result?.sms_sent).toBe(50);
      expect(result?.calls_made).toBe(5);
    });

    it("returns null on db error", async () => {
      const db = mockDb({
        single: vi.fn().mockResolvedValue({ data: null, error: { message: "not found" } })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await getTodayUsage("bad-id");
      expect(result).toBeNull();
    });

    it("uses provided client", async () => {
      const db = mockDb();
      const result = await getTodayUsage("biz-uuid-1", db as never);
      expect(result?.business_id).toBe("biz-uuid-1");
      expect(createSupabaseServiceClient).not.toHaveBeenCalled();
    });
  });

  describe("getCalendarMonthUsageTotals", () => {
    it("throws when the query returns an error", async () => {
      const monthThenable: PromiseLike<{ data: null; error: { message: string } }> = {
        then(onFulfilled, onRejected) {
          return Promise.resolve({ data: null, error: { message: "db" } }).then(onFulfilled, onRejected);
        }
      };
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.gte = vi.fn(() => monthThenable);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(getCalendarMonthUsageTotals("biz-uuid-1", chain as never)).rejects.toThrow(
        "getCalendarMonthUsageTotals: db"
      );
      expect(err).toHaveBeenCalled();

      err.mockRestore();
    });

    it("sums rows for the month", async () => {
      const monthThenable: PromiseLike<{
        data: Array<{ sms_sent: number; calls_made: number }>;
        error: null;
      }> = {
        then(onFulfilled, onRejected) {
          return Promise.resolve({
            data: [
              { sms_sent: 3, calls_made: 1 },
              { sms_sent: 2, calls_made: 4 }
            ],
            error: null
          }).then(onFulfilled, onRejected);
        }
      };
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.gte = vi.fn(() => monthThenable);

      const result = await getCalendarMonthUsageTotals("biz-uuid-1", chain as never);
      expect(result).toEqual({ sms_sent: 5, calls_made: 5 });
    });

    it("treats null data as empty and null row fields as zero", async () => {
      const monthThenable: PromiseLike<{
        data: null;
        error: null;
      }> = {
        then(onFulfilled, onRejected) {
          return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
        }
      };
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.gte = vi.fn(() => monthThenable);

      const empty = await getCalendarMonthUsageTotals("biz-uuid-1", chain as never);
      expect(empty).toEqual({ sms_sent: 0, calls_made: 0 });

      const sparseThenable: PromiseLike<{
        data: Array<{ sms_sent?: number | null; calls_made?: number | null }>;
        error: null;
      }> = {
        then(onFulfilled, onRejected) {
          return Promise.resolve({
            data: [{ sms_sent: null }, { calls_made: null }],
            error: null
          }).then(onFulfilled, onRejected);
        }
      };
      chain.gte = vi.fn(() => sparseThenable);
      const sparse = await getCalendarMonthUsageTotals("biz-uuid-1", chain as never);
      expect(sparse).toEqual({ sms_sent: 0, calls_made: 0 });
    });
  });

  describe("getFleetCalendarMonthUsageTotals", () => {
    type FleetPage = {
      data: Array<Record<string, number | string | null>> | null;
      error: { message: string } | null;
    };

    /**
     * Per-table chains ending at `.range()`, resolving queued pages in order
     * (daily_usage for SMS, voice_settlements for billable seconds).
     */
    function fleetChain(pagesByTable: Record<string, FleetPage[]>) {
      const calls: Record<string, number> = {};
      const rangeSpies: Record<string, ReturnType<typeof vi.fn>> = {};
      const from = vi.fn((table: string) => {
        const pages = pagesByTable[table] ?? [{ data: [], error: null }];
        rangeSpies[table] ??= vi.fn(async () => {
          const i = calls[table] ?? 0;
          calls[table] = i + 1;
          return pages[Math.min(i, pages.length - 1)];
        });
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn(() => chain);
        chain.gte = vi.fn(() => chain);
        chain.order = vi.fn(() => chain);
        chain.range = rangeSpies[table];
        return chain;
      });
      return { from, rangeSpies };
    }

    it("sums fleet SMS from daily_usage and voice minutes from settled billable seconds", async () => {
      const db = fleetChain({
        daily_usage: [{ data: [{ sms_sent: 3 }, { sms_sent: 2 }], error: null }],
        voice_settlements: [
          { data: [{ billable_seconds: 600 }, { billable_seconds: 270 }], error: null }
        ]
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      expect(await getFleetCalendarMonthUsageTotals()).toEqual({
        smsSent: 5,
        voiceMinutes: 14.5
      });
    });

    it("pages both reads past PostgREST's 1000-row cap instead of silently truncating", async () => {
      const smsPage = Array.from({ length: 1000 }, () => ({ sms_sent: 1 }));
      const voicePage = Array.from({ length: 1000 }, () => ({ billable_seconds: 60 }));
      const db = fleetChain({
        daily_usage: [
          { data: smsPage, error: null },
          { data: [{ sms_sent: 5 }], error: null }
        ],
        voice_settlements: [
          { data: voicePage, error: null },
          { data: [{ billable_seconds: 120 }], error: null }
        ]
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      expect(await getFleetCalendarMonthUsageTotals()).toEqual({
        smsSent: 1005,
        voiceMinutes: 1002
      });
      for (const table of ["daily_usage", "voice_settlements"]) {
        expect(db.rangeSpies[table]).toHaveBeenCalledTimes(2);
        expect(db.rangeSpies[table]).toHaveBeenNthCalledWith(1, 0, 999);
        expect(db.rangeSpies[table]).toHaveBeenNthCalledWith(2, 1000, 1999);
      }
    });

    it("treats null data as empty and null fields as zero (explicit client)", async () => {
      const empty = fleetChain({
        daily_usage: [{ data: null, error: null }],
        voice_settlements: [{ data: null, error: null }]
      });
      expect(await getFleetCalendarMonthUsageTotals(empty as never)).toEqual({
        smsSent: 0,
        voiceMinutes: 0
      });
      expect(createSupabaseServiceClient).not.toHaveBeenCalled();

      const sparse = fleetChain({
        daily_usage: [{ data: [{ sms_sent: null }], error: null }],
        voice_settlements: [{ data: [{ billable_seconds: null }], error: null }]
      });
      expect(await getFleetCalendarMonthUsageTotals(sparse as never)).toEqual({
        smsSent: 0,
        voiceMinutes: 0
      });
    });

    it("throws when either read fails", async () => {
      const smsErr = fleetChain({
        daily_usage: [{ data: null, error: { message: "db down" } }]
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(smsErr as never);
      await expect(getFleetCalendarMonthUsageTotals()).rejects.toThrow(
        "getFleetCalendarMonthUsageTotals: db down"
      );

      const voiceErr = fleetChain({
        daily_usage: [{ data: [], error: null }],
        voice_settlements: [{ data: null, error: { message: "settlements down" } }]
      });
      await expect(getFleetCalendarMonthUsageTotals(voiceErr as never)).rejects.toThrow(
        "getFleetCalendarMonthUsageTotals: settlements down"
      );
    });
  });

  describe("peakConcurrentFromIntervals", () => {
    it("returns 0 for no intervals", () => {
      expect(peakConcurrentFromIntervals([])).toBe(0);
    });

    it("counts overlapping calls and ignores disjoint ones", () => {
      expect(
        peakConcurrentFromIntervals([
          { startMs: 0, endMs: 100 },
          { startMs: 50, endMs: 150 }, // overlaps the first → 2
          { startMs: 200, endMs: 300 } // disjoint
        ])
      ).toBe(2);
    });

    it("does not treat an end meeting a start at the same instant as overlap", () => {
      expect(
        peakConcurrentFromIntervals([
          { startMs: 0, endMs: 100 },
          { startMs: 100, endMs: 200 }
        ])
      ).toBe(1);
    });

    it("handles nested intervals", () => {
      expect(
        peakConcurrentFromIntervals([
          { startMs: 0, endMs: 1000 },
          { startMs: 100, endMs: 900 },
          { startMs: 200, endMs: 800 }
        ])
      ).toBe(3);
    });
  });

  describe("getFleetCalendarMonthUsageByBusiness", () => {
    type FleetPage = {
      data: Array<Record<string, number | string | null>> | null;
      error: { message: string } | null;
    };

    function fleetChain(pagesByTable: Record<string, FleetPage[]>) {
      const calls: Record<string, number> = {};
      const rangeSpies: Record<string, ReturnType<typeof vi.fn>> = {};
      const from = vi.fn((table: string) => {
        const pages = pagesByTable[table] ?? [{ data: [], error: null }];
        rangeSpies[table] ??= vi.fn(async () => {
          const i = calls[table] ?? 0;
          calls[table] = i + 1;
          return pages[Math.min(i, pages.length - 1)];
        });
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn(() => chain);
        chain.gte = vi.fn(() => chain);
        chain.lt = vi.fn(() => chain);
        chain.neq = vi.fn(() => chain);
        chain.order = vi.fn(() => chain);
        chain.range = rangeSpies[table];
        return chain;
      });
      return { from, rangeSpies };
    }

    it("groups SMS from daily_usage, minutes+calls from settlements, and peak from transcript overlap", async () => {
      const db = fleetChain({
        daily_usage: [
          {
            data: [
              { business_id: "biz-1", sms_sent: 3 },
              { business_id: "biz-1", sms_sent: 2 },
              { business_id: "biz-2", sms_sent: 7 },
              { sms_sent: 99 } // no business_id — skipped
            ],
            error: null
          }
        ],
        voice_settlements: [
          {
            data: [
              { business_id: "biz-1", billable_seconds: 600 },
              { business_id: "biz-1", billable_seconds: 30 },
              { business_id: "biz-3", billable_seconds: 90 },
              { billable_seconds: 999 } // no business_id — skipped
            ],
            error: null
          }
        ],
        voice_call_transcripts: [
          {
            data: [
              // biz-1: two overlapping calls + one disjoint → peak 2
              {
                business_id: "biz-1",
                started_at: "2026-07-05T10:00:00.000Z",
                ended_at: "2026-07-05T10:05:00.000Z"
              },
              {
                business_id: "biz-1",
                started_at: "2026-07-05T10:03:00.000Z",
                ended_at: "2026-07-05T10:04:00.000Z"
              },
              {
                business_id: "biz-1",
                started_at: "2026-07-05T11:00:00.000Z",
                ended_at: "2026-07-05T11:01:00.000Z"
              },
              // transcript-only business still gets an entry
              {
                business_id: "biz-4",
                started_at: "2026-07-06T09:00:00.000Z",
                ended_at: "2026-07-06T09:02:00.000Z"
              },
              // skipped rows: no business_id, no ended_at (in progress),
              // unparsable timestamp, end <= start
              {
                started_at: "2026-07-05T10:00:00.000Z",
                ended_at: "2026-07-05T10:01:00.000Z"
              },
              { business_id: "biz-1", started_at: "2026-07-05T10:00:00.000Z", ended_at: null },
              { business_id: "biz-1", started_at: "not-a-date", ended_at: "also-not-a-date" },
              {
                business_id: "biz-1",
                started_at: "2026-07-05T10:01:00.000Z",
                ended_at: "2026-07-05T10:01:00.000Z"
              }
            ],
            error: null
          }
        ]
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      const map = await getFleetCalendarMonthUsageByBusiness();
      expect(map.get("biz-1")).toEqual({
        smsSent: 5,
        voiceMinutes: 10.5,
        callsMade: 2,
        peakConcurrentCalls: 2
      });
      expect(map.get("biz-2")).toEqual({
        smsSent: 7,
        voiceMinutes: 0,
        callsMade: 0,
        peakConcurrentCalls: 0
      });
      // Voice-only business still gets an entry (settlements pass created
      // it); with no transcript rows its peak stays 0.
      expect(map.get("biz-3")).toEqual({
        smsSent: 0,
        voiceMinutes: 1.5,
        callsMade: 1,
        peakConcurrentCalls: 0
      });
      expect(map.get("biz-4")).toEqual({
        smsSent: 0,
        voiceMinutes: 0,
        callsMade: 0,
        peakConcurrentCalls: 1
      });
    });

    it("pages all three reads past the 1000-row cap and tolerates null data/fields (explicit client)", async () => {
      const smsPage = Array.from({ length: 1000 }, () => ({
        business_id: "biz-1",
        sms_sent: 1
      }));
      const voicePage = Array.from({ length: 1000 }, () => ({
        business_id: "biz-1",
        billable_seconds: 60
      }));
      const transcriptPage = Array.from({ length: 1000 }, () => ({
        business_id: "biz-1",
        started_at: "2026-07-01T00:00:00.000Z",
        ended_at: "2026-07-01T00:01:00.000Z"
      }));
      const db = fleetChain({
        daily_usage: [
          { data: smsPage, error: null },
          {
            data: [
              { business_id: "biz-1", sms_sent: 5 },
              { business_id: "biz-1", sms_sent: null } // null SMS field → zero
            ],
            error: null
          }
        ],
        voice_settlements: [
          { data: voicePage, error: null },
          { data: [{ business_id: "biz-1", billable_seconds: null }], error: null }
        ],
        voice_call_transcripts: [
          { data: transcriptPage, error: null },
          {
            data: [
              {
                business_id: "biz-1",
                started_at: "2026-07-01T00:00:00.000Z",
                ended_at: "2026-07-01T00:01:00.000Z"
              }
            ],
            error: null
          }
        ]
      });
      const map = await getFleetCalendarMonthUsageByBusiness(db as never);
      expect(createSupabaseServiceClient).not.toHaveBeenCalled();
      expect(map.get("biz-1")).toEqual({
        smsSent: 1005,
        voiceMinutes: 1000,
        callsMade: 1001,
        peakConcurrentCalls: 1001
      });
      expect(db.rangeSpies.daily_usage).toHaveBeenNthCalledWith(2, 1000, 1999);
      expect(db.rangeSpies.voice_settlements).toHaveBeenNthCalledWith(2, 1000, 1999);
      expect(db.rangeSpies.voice_call_transcripts).toHaveBeenNthCalledWith(2, 1000, 1999);

      const empty = fleetChain({
        daily_usage: [{ data: null, error: null }],
        voice_settlements: [{ data: null, error: null }],
        voice_call_transcripts: [{ data: null, error: null }]
      });
      expect((await getFleetCalendarMonthUsageByBusiness(empty as never)).size).toBe(0);
    });

    it("applies a historical month window to all three reads and excludes missed transcripts", async () => {
      const chains: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
      const from = vi.fn(() => {
        const chain: Record<string, ReturnType<typeof vi.fn>> = {};
        chain.select = vi.fn(() => chain);
        chain.gte = vi.fn(() => chain);
        chain.lt = vi.fn(() => chain);
        chain.neq = vi.fn(() => chain);
        chain.order = vi.fn(() => chain);
        chain.range = vi.fn(async () => ({ data: [], error: null }));
        chains.push(chain);
        return chain;
      });
      await getFleetCalendarMonthUsageByBusiness({ from } as never, {
        startYmd: "2026-06-01",
        endYmdExclusive: "2026-07-01"
      });
      expect(chains[0].gte).toHaveBeenCalledWith("usage_date", "2026-06-01");
      expect(chains[0].lt).toHaveBeenCalledWith("usage_date", "2026-07-01");
      expect(chains[1].gte).toHaveBeenCalledWith("created_at", "2026-06-01T00:00:00.000Z");
      expect(chains[1].lt).toHaveBeenCalledWith("created_at", "2026-07-01T00:00:00.000Z");
      expect(chains[2].gte).toHaveBeenCalledWith("started_at", "2026-06-01T00:00:00.000Z");
      expect(chains[2].lt).toHaveBeenCalledWith("started_at", "2026-07-01T00:00:00.000Z");
      expect(chains[2].neq).toHaveBeenCalledWith("status", "missed");
    });

    it("supports an open-ended window (start only)", async () => {
      const chains: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
      const from = vi.fn(() => {
        const chain: Record<string, ReturnType<typeof vi.fn>> = {};
        chain.select = vi.fn(() => chain);
        chain.gte = vi.fn(() => chain);
        chain.lt = vi.fn(() => chain);
        chain.neq = vi.fn(() => chain);
        chain.order = vi.fn(() => chain);
        chain.range = vi.fn(async () => ({ data: [], error: null }));
        chains.push(chain);
        return chain;
      });
      await getFleetCalendarMonthUsageByBusiness({ from } as never, { startYmd: "2026-06-01" });
      expect(chains[0].lt).not.toHaveBeenCalled();
      expect(chains[1].lt).not.toHaveBeenCalled();
      expect(chains[2].lt).not.toHaveBeenCalled();
    });

    it("throws when any read fails", async () => {
      const smsErr = fleetChain({
        daily_usage: [{ data: null, error: { message: "db down" } }]
      });
      await expect(getFleetCalendarMonthUsageByBusiness(smsErr as never)).rejects.toThrow(
        "getFleetCalendarMonthUsageByBusiness: db down"
      );

      const voiceErr = fleetChain({
        daily_usage: [{ data: [], error: null }],
        voice_settlements: [{ data: null, error: { message: "settlements down" } }]
      });
      await expect(getFleetCalendarMonthUsageByBusiness(voiceErr as never)).rejects.toThrow(
        "getFleetCalendarMonthUsageByBusiness: settlements down"
      );

      const transcriptErr = fleetChain({
        daily_usage: [{ data: [], error: null }],
        voice_settlements: [{ data: [], error: null }],
        voice_call_transcripts: [{ data: null, error: { message: "transcripts down" } }]
      });
      await expect(getFleetCalendarMonthUsageByBusiness(transcriptErr as never)).rejects.toThrow(
        "getFleetCalendarMonthUsageByBusiness: transcripts down"
      );
    });
  });

  describe("incrementUsage", () => {
    it("calls rpc with correct arguments", async () => {
      const rpcFn = vi.fn().mockResolvedValue({ error: null });
      const db = mockDb({ rpc: rpcFn });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await incrementUsage("biz-uuid-1", "sms_sent", 5);
      expect(rpcFn).toHaveBeenCalledWith("increment_usage", {
        p_business_id: "biz-uuid-1",
        p_field: "sms_sent",
        p_amount: 5
      });
    });

    it("uses provided client and skips createSupabaseServiceClient", async () => {
      const rpcFn = vi.fn().mockResolvedValue({ error: null });
      const db = mockDb({ rpc: rpcFn });

      await incrementUsage("biz-uuid-1", "calls_made", 1, db as never);
      expect(createSupabaseServiceClient).not.toHaveBeenCalled();
      expect(rpcFn).toHaveBeenCalledOnce();
    });

    it("calls rpc for voice_minutes_used", async () => {
      const rpcFn = vi.fn().mockResolvedValue({ error: null });
      const db = mockDb({ rpc: rpcFn });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await incrementUsage("biz-uuid-1", "voice_minutes_used", 10);
      expect(rpcFn).toHaveBeenCalledWith("increment_usage", {
        p_business_id: "biz-uuid-1",
        p_field: "voice_minutes_used",
        p_amount: 10
      });
    });

    it("throws when rpc returns an error", async () => {
      const db = mockDb({
        rpc: vi.fn().mockResolvedValue({ error: { message: "rpc fail" } })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await expect(
        incrementUsage("biz-uuid-1", "voice_minutes_used", 10)
      ).rejects.toThrow("incrementUsage: rpc fail");
    });

    it("throws when rpc returns a different field error", async () => {
      const db = mockDb({
        rpc: vi.fn().mockResolvedValue({ error: { message: "insert fail" } })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await expect(
        incrementUsage("biz-uuid-1", "sms_sent", 1)
      ).rejects.toThrow("incrementUsage: insert fail");
    });
  });

  describe("checkLimitReached", () => {
    it("allows standard tier when under monthly SMS cap", async () => {
      const cap = TIER_LIMITS.standard.smsPerMonth;
      const db = mockLimitClient({ monthRows: [{ sms_sent: cap - 1, calls_made: 0 }] });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await checkLimitReached("biz-uuid-1", "standard");
      expect(result.allowed).toBe(true);
    });

    it("allows enterprise tier (all caps unlimited)", async () => {
      const db = mockDb();
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await checkLimitReached("biz-uuid-1", "enterprise");
      expect(result.allowed).toBe(true);
    });

    it("applies enterprise admin override for daily voice cap", async () => {
      const db = mockLimitClient({
        today: { ...MOCK_USAGE, voice_minutes_used: 100, sms_sent: 0, calls_made: 0 },
        monthRows: []
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await checkLimitReached("biz-uuid-1", "enterprise", undefined, {
        voiceMinutesPerDay: 100
      });
      expect(result.allowed).toBe(false);
      expect(result.field).toBe("voice_minutes_used");
    });

    it("enterprise daily voice cap allows when there is no usage row for today", async () => {
      const db = mockLimitClient({
        today: null,
        monthRows: []
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await checkLimitReached("biz-uuid-1", "enterprise", undefined, {
        voiceMinutesPerDay: 100
      });
      expect(result.allowed).toBe(true);
    });

    it("allows starter tier when under all monthly limits", async () => {
      const db = mockLimitClient({
        monthRows: [{ sms_sent: 10, calls_made: 3 }]
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await checkLimitReached("biz-uuid-1", "starter");
      expect(result.allowed).toBe(true);
    });

    it("does not block starter on legacy daily_usage voice minutes (voice quota is Stripe-period Telnyx pool)", async () => {
      const db = mockLimitClient({
        monthRows: [{ sms_sent: 0, calls_made: 0 }]
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await checkLimitReached("biz-uuid-1", "starter");
      expect(result.allowed).toBe(true);
    });

    it("blocks starter when monthly SMS limit reached", async () => {
      const cap = TIER_LIMITS.starter.smsPerMonth;
      const db = mockLimitClient({
        monthRows: [{ sms_sent: cap, calls_made: 0 }]
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await checkLimitReached("biz-uuid-1", "starter");
      expect(result.allowed).toBe(false);
      expect(result.field).toBe("sms_sent");
      expect(result.reason).toContain(String(cap));
      expect(result.reason).toContain("SMS/month");
    });

    it("allows starter when there is no usage yet this month", async () => {
      const db = mockLimitClient({ monthRows: [] });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await checkLimitReached("biz-uuid-1", "starter");
      expect(result.allowed).toBe(true);
    });

    it("blocks SMS when monthly usage query fails (fail closed)", async () => {
      const db = mockLimitClient({ monthError: { message: "timeout" } });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await checkLimitReached("biz-uuid-1", "starter");
      expect(result.allowed).toBe(false);
      expect(result.field).toBe("sms_sent");
      expect(result.reason).toContain("Cannot verify monthly SMS usage");
      expect(log).toHaveBeenCalled();

      log.mockRestore();
    });
  });
});
