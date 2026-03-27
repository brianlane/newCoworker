import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTodayUsage, incrementUsage, checkLimitReached } from "@/lib/db/usage";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/plans/limits", () => ({
  TIER_LIMITS: {
    starter: {
      voiceMinutesPerDay: 60,
      smsPerDay: 100,
      callsPerDay: 10,
      maxConcurrentCalls: 1,
      smsThrottled: true,
      memoryType: "lossless"
    },
    standard: {
      voiceMinutesPerDay: Infinity,
      smsPerDay: Infinity,
      callsPerDay: Infinity,
      maxConcurrentCalls: 3,
      smsThrottled: false,
      memoryType: "lossless"
    },
    enterprise: {
      voiceMinutesPerDay: Infinity,
      smsPerDay: Infinity,
      callsPerDay: Infinity,
      maxConcurrentCalls: 10,
      smsThrottled: false,
      memoryType: "lossless"
    }
  }
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
    ...overrides
  };
  return base;
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

  describe("incrementUsage", () => {
    it("updates existing row", async () => {
      const secondEqFn = vi.fn().mockResolvedValue({ error: null });
      const firstEqFn = vi.fn().mockReturnValue({ eq: secondEqFn });
      const updateFn = vi.fn().mockReturnValue({ eq: firstEqFn });
      const db = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        update: updateFn,
        insert: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: "u1", sms_sent: 10 },
          error: null
        })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await incrementUsage("biz-uuid-1", "sms_sent", 5);
      expect(updateFn).toHaveBeenCalledWith(
        expect.objectContaining({ sms_sent: 15 })
      );
    });

    it("treats null field value as 0 when updating (nullish coalescing branch)", async () => {
      const secondEqFn = vi.fn().mockResolvedValue({ error: null });
      const firstEqFn = vi.fn().mockReturnValue({ eq: secondEqFn });
      const updateFn = vi.fn().mockReturnValue({ eq: firstEqFn });
      const db = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        update: updateFn,
        insert: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: "u1", sms_sent: null },
          error: null
        })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await incrementUsage("biz-uuid-1", "sms_sent", 3);
      expect(updateFn).toHaveBeenCalledWith(
        expect.objectContaining({ sms_sent: 3 })
      );
    });

    it("inserts new row when no existing usage", async () => {
      const insertFn = vi.fn().mockResolvedValue({ error: null });
      const db = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        insert: insertFn,
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: { message: "no rows" } })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await incrementUsage("biz-uuid-1", "calls_made", 1);
      expect(insertFn).toHaveBeenCalledWith(
        expect.objectContaining({ calls_made: 1, business_id: "biz-uuid-1" })
      );
    });

    it("throws when update fails", async () => {
      const secondEqFn = vi.fn().mockResolvedValue({ error: { message: "db fail" } });
      const firstEqFn = vi.fn().mockReturnValue({ eq: secondEqFn });
      const db = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnValue({ eq: firstEqFn }),
        insert: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: "u1", voice_minutes_used: 20 },
          error: null
        })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await expect(
        incrementUsage("biz-uuid-1", "voice_minutes_used", 10)
      ).rejects.toThrow("incrementUsage update");
    });

    it("throws when insert fails", async () => {
      const db = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockResolvedValue({ error: { message: "insert fail" } }),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: { message: "no rows" } })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await expect(
        incrementUsage("biz-uuid-1", "sms_sent", 1)
      ).rejects.toThrow("incrementUsage insert");
    });
  });

  describe("checkLimitReached", () => {
    it("allows standard tier (unlimited limits)", async () => {
      const db = mockDb();
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await checkLimitReached("biz-uuid-1", "standard");
      expect(result.allowed).toBe(true);
    });

    it("allows enterprise tier (unlimited limits)", async () => {
      const db = mockDb();
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await checkLimitReached("biz-uuid-1", "enterprise");
      expect(result.allowed).toBe(true);
    });

    it("allows starter tier when under all limits", async () => {
      const db = mockDb({
        single: vi.fn().mockResolvedValue({
          data: { ...MOCK_USAGE, voice_minutes_used: 30, sms_sent: 50, calls_made: 5 },
          error: null
        })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await checkLimitReached("biz-uuid-1", "starter");
      expect(result.allowed).toBe(true);
    });

    it("blocks starter when voice limit reached", async () => {
      const db = mockDb({
        single: vi.fn().mockResolvedValue({
          data: { ...MOCK_USAGE, voice_minutes_used: 60 },
          error: null
        })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await checkLimitReached("biz-uuid-1", "starter");
      expect(result.allowed).toBe(false);
      expect(result.field).toBe("voice_minutes_used");
      expect(result.reason).toContain("60 minutes");
    });

    it("blocks starter when SMS limit reached", async () => {
      const db = mockDb({
        single: vi.fn().mockResolvedValue({
          data: { ...MOCK_USAGE, voice_minutes_used: 0, sms_sent: 100 },
          error: null
        })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await checkLimitReached("biz-uuid-1", "starter");
      expect(result.allowed).toBe(false);
      expect(result.field).toBe("sms_sent");
      expect(result.reason).toContain("100 SMS");
    });

    it("blocks starter when call limit reached", async () => {
      const db = mockDb({
        single: vi.fn().mockResolvedValue({
          data: { ...MOCK_USAGE, voice_minutes_used: 0, sms_sent: 0, calls_made: 10 },
          error: null
        })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await checkLimitReached("biz-uuid-1", "starter");
      expect(result.allowed).toBe(false);
      expect(result.field).toBe("calls_made");
      expect(result.reason).toContain("10 calls");
    });

    it("allows starter when no usage row exists (first use of the day)", async () => {
      const db = mockDb({
        single: vi.fn().mockResolvedValue({ data: null, error: { message: "no rows" } })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await checkLimitReached("biz-uuid-1", "starter");
      expect(result.allowed).toBe(true);
    });
  });
});
