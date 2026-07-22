import { describe, it, expect, vi, beforeEach } from "vitest";
import { insertCoworkerLog, getRecentAlertsAll, getRecentLogs, getRecentLogsAll } from "@/lib/db/logs";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const MOCK_LOG = {
  id: "log-uuid-1",
  business_id: "biz-uuid-1",
  task_type: "call",
  status: "success",
  log_payload: { caller: "+15550001111" },
  created_at: "2026-01-01T00:00:00Z"
};

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: MOCK_LOG, error: null }),
    ...overrides
  };
}

describe("db/logs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("insertCoworkerLog inserts and returns row", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await insertCoworkerLog({
      id: "log-uuid-1",
      business_id: "biz-uuid-1",
      task_type: "call",
      status: "success",
      log_payload: { caller: "+15550001111" }
    });
    expect(result.task_type).toBe("call");
  });

  it("insertCoworkerLog throws on error", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: null, error: { message: "fail" } }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(insertCoworkerLog({
      id: "x",
      business_id: "y",
      task_type: "call",
      status: "error",
      log_payload: {}
    })).rejects.toThrow("insertCoworkerLog");
  });

  it("getRecentLogs returns array", async () => {
    const db = { ...mockDb(), limit: vi.fn().mockResolvedValue({ data: [MOCK_LOG], error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await getRecentLogs("biz-uuid-1", 10);
    expect(result).toHaveLength(1);
  });

  it("getRecentLogs excludes provisioning when requested", async () => {
    const neq = vi.fn().mockReturnThis();
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      neq,
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [MOCK_LOG], error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await getRecentLogs("biz-uuid-1", 10, undefined, { excludeProvisioning: true });
    expect(neq).toHaveBeenCalledWith("task_type", "provisioning");
  });

  it("getRecentLogs throws on error", async () => {
    const db = { ...mockDb(), limit: vi.fn().mockResolvedValue({ data: null, error: { message: "err" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getRecentLogs("biz-uuid-1")).rejects.toThrow("getRecentLogs");
  });

  it("getRecentLogs returns empty array when data is null with no error", async () => {
    const db = { ...mockDb(), limit: vi.fn().mockResolvedValue({ data: null, error: null }) };
    const result = await getRecentLogs("biz-uuid-1", 10, db as never);
    expect(result).toEqual([]);
  });

  it("insertCoworkerLog uses provided client", async () => {
    const db = mockDb();
    const result = await insertCoworkerLog(
      { id: "x", business_id: "y", task_type: "call", status: "success", log_payload: {} },
      db as never
    );
    expect(result.task_type).toBe("call");
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("getRecentAlertsAll returns alerts", async () => {
    const db = { ...mockDb(), limit: vi.fn().mockResolvedValue({ data: [MOCK_LOG], error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await getRecentAlertsAll(5);
    expect(result).toEqual([MOCK_LOG]);
  });

  it("getRecentAlertsAll throws on error", async () => {
    const db = { ...mockDb(), limit: vi.fn().mockResolvedValue({ data: null, error: { message: "err" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getRecentAlertsAll()).rejects.toThrow("getRecentAlertsAll");
  });

  it("getRecentAlertsAll returns empty array when data is null with no error", async () => {
    const db = { ...mockDb(), limit: vi.fn().mockResolvedValue({ data: null, error: null }) };

    await expect(getRecentAlertsAll(5, db as never)).resolves.toEqual([]);
  });

  it("getRecentAlertsAll excludes muted businesses", async () => {
    const not = vi.fn().mockReturnThis();
    const db = {
      ...mockDb(),
      not,
      limit: vi.fn().mockResolvedValue({ data: [MOCK_LOG], error: null })
    };

    await getRecentAlertsAll(5, db as never, { excludeBusinessIds: ["biz-a", "biz-b"] });
    expect(not).toHaveBeenCalledWith("business_id", "in", "(biz-a,biz-b)");
  });

  it("getRecentAlertsAll skips the exclusion clause for an empty list", async () => {
    const not = vi.fn().mockReturnThis();
    const db = {
      ...mockDb(),
      not,
      limit: vi.fn().mockResolvedValue({ data: [MOCK_LOG], error: null })
    };

    await getRecentAlertsAll(5, db as never, { excludeBusinessIds: [] });
    expect(not).not.toHaveBeenCalled();
  });

  it("getRecentLogsAll returns logs", async () => {
    const db = { ...mockDb(), limit: vi.fn().mockResolvedValue({ data: [MOCK_LOG], error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await getRecentLogsAll(5);
    expect(result).toEqual([MOCK_LOG]);
  });

  it("getRecentLogsAll throws on error", async () => {
    const db = { ...mockDb(), limit: vi.fn().mockResolvedValue({ data: null, error: { message: "err" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getRecentLogsAll()).rejects.toThrow("getRecentLogsAll");
  });

  it("getRecentLogsAll returns empty array when data is null with no error", async () => {
    const db = { ...mockDb(), limit: vi.fn().mockResolvedValue({ data: null, error: null }) };

    await expect(getRecentLogsAll(5, db as never)).resolves.toEqual([]);
  });

  it("getRecentLogsAll excludes muted businesses", async () => {
    const not = vi.fn().mockReturnThis();
    const db = {
      ...mockDb(),
      not,
      limit: vi.fn().mockResolvedValue({ data: [MOCK_LOG], error: null })
    };

    await getRecentLogsAll(5, db as never, { excludeBusinessIds: ["biz-a"] });
    expect(not).toHaveBeenCalledWith("business_id", "in", "(biz-a)");
  });

  it("getRecentLogsAll skips the exclusion clause for an empty list", async () => {
    const not = vi.fn().mockReturnThis();
    const db = {
      ...mockDb(),
      not,
      limit: vi.fn().mockResolvedValue({ data: [MOCK_LOG], error: null })
    };

    await getRecentLogsAll(5, db as never, { excludeBusinessIds: [] });
    expect(not).not.toHaveBeenCalled();
  });

  it("getRecentLogsAll excludes requested statuses", async () => {
    const not = vi.fn().mockReturnThis();
    const db = {
      ...mockDb(),
      not,
      limit: vi.fn().mockResolvedValue({ data: [MOCK_LOG], error: null })
    };

    await getRecentLogsAll(5, db as never, { excludeStatuses: ["urgent_alert", "error"] });
    expect(not).toHaveBeenCalledWith("status", "in", "(urgent_alert,error)");
  });

  it("getRecentLogsAll skips the status clause for an empty list", async () => {
    const not = vi.fn().mockReturnThis();
    const db = {
      ...mockDb(),
      not,
      limit: vi.fn().mockResolvedValue({ data: [MOCK_LOG], error: null })
    };

    await getRecentLogsAll(5, db as never, { excludeStatuses: [] });
    expect(not).not.toHaveBeenCalled();
  });
});
