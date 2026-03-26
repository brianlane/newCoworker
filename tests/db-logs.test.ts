import { describe, it, expect, vi, beforeEach } from "vitest";
import { insertCoworkerLog, getRecentLogs } from "@/lib/db/logs";

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
});
