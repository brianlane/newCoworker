import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTodayUsage, getCalendarMonthUsageTotals, incrementUsage, checkLimitReached } from "@/lib/db/usage";
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
}) {
  const today = opts.today !== undefined ? opts.today : MOCK_USAGE;
  const monthRows = opts.monthRows ?? [];

  const monthThenable: PromiseLike<{ data: typeof monthRows; error: null }> = {
    then(onFulfilled, onRejected) {
      return Promise.resolve({ data: monthRows, error: null }).then(onFulfilled, onRejected);
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
    it("returns zeros when the query returns an error", async () => {
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

      const result = await getCalendarMonthUsageTotals("biz-uuid-1", chain as never);
      expect(result).toEqual({ sms_sent: 0, calls_made: 0 });
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
  });
});
