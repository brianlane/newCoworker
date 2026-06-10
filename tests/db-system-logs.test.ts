import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  insertSystemLog,
  recordSystemLog,
  listSystemLogs,
  listSystemLogErrorsAll
} from "@/lib/db/system-logs";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const MOCK_ROW = {
  id: 1,
  business_id: "biz-uuid-1",
  source: "aiflow",
  level: "error",
  event: "ai_flow_run_failed",
  message: "telnyx 500",
  payload: { run_id: "run-1" },
  created_at: "2026-06-09T00:00:00Z"
};

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn().mockResolvedValue({ error: null }),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [MOCK_ROW], error: null }),
    ...overrides
  };
}

describe("db/system-logs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("insertSystemLog inserts a normalized row", async () => {
    const db = mockDb();
    await insertSystemLog(
      {
        businessId: "biz-uuid-1",
        source: "aiflow",
        level: "error",
        event: "ai_flow_run_failed",
        message: "telnyx 500",
        payload: { run_id: "run-1" }
      },
      db as never
    );
    expect(db.from).toHaveBeenCalledWith("system_logs");
    expect(db.insert).toHaveBeenCalledWith({
      business_id: "biz-uuid-1",
      source: "aiflow",
      level: "error",
      event: "ai_flow_run_failed",
      message: "telnyx 500",
      payload: { run_id: "run-1" }
    });
  });

  it("insertSystemLog defaults business_id to null and payload to {}", async () => {
    const db = mockDb();
    await insertSystemLog(
      { source: "app", level: "info", event: "fleet_sweep" },
      db as never
    );
    expect(db.insert).toHaveBeenCalledWith(
      expect.objectContaining({ business_id: null, payload: {}, message: "" })
    );
  });

  it("insertSystemLog truncates oversized messages", async () => {
    const db = mockDb();
    await insertSystemLog(
      { source: "app", level: "warn", event: "x", message: "a".repeat(5000) },
      db as never
    );
    const inserted = db.insert.mock.calls[0][0] as { message: string };
    expect(inserted.message).toHaveLength(4000);
  });

  it("insertSystemLog throws on insert error", async () => {
    const db = mockDb({ insert: vi.fn().mockResolvedValue({ error: { message: "boom" } }) });
    await expect(
      insertSystemLog({ source: "app", level: "error", event: "x" }, db as never)
    ).rejects.toThrow("insertSystemLog: boom");
  });

  it("recordSystemLog never throws when the insert fails", async () => {
    const db = mockDb({ insert: vi.fn().mockResolvedValue({ error: { message: "down" } }) });
    await expect(
      recordSystemLog({ source: "app", level: "error", event: "x" }, db as never)
    ).resolves.toBeUndefined();
  });

  it("recordSystemLog never throws when client creation fails", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    await expect(
      recordSystemLog({ source: "app", level: "info", event: "x" })
    ).resolves.toBeUndefined();
  });

  it("recordSystemLog stringifies non-Error failures", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValue("string blowup");
    await expect(
      recordSystemLog({ source: "app", level: "info", event: "x" })
    ).resolves.toBeUndefined();
  });

  it("insertSystemLog falls back to the service client when none is passed", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await insertSystemLog({ source: "app", level: "info", event: "x" });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalled();
  });

  it("listSystemLogs scopes to business and applies exact level", async () => {
    const db = mockDb();
    const rows = await listSystemLogs("biz-uuid-1", { level: "error" }, db as never);
    expect(rows).toEqual([MOCK_ROW]);
    expect(db.eq).toHaveBeenCalledWith("business_id", "biz-uuid-1");
    expect(db.eq).toHaveBeenCalledWith("level", "error");
  });

  it("listSystemLogs expands minLevel into an in() filter", async () => {
    const db = mockDb();
    await listSystemLogs("biz-uuid-1", { minLevel: "warn" }, db as never);
    expect(db.in).toHaveBeenCalledWith("level", ["warn", "error"]);
  });

  it("listSystemLogs treats minLevel=debug as no level filter", async () => {
    const db = mockDb();
    await listSystemLogs("biz-uuid-1", { minLevel: "debug" }, db as never);
    expect(db.in).not.toHaveBeenCalled();
    expect(db.eq).toHaveBeenCalledTimes(1); // business_id only
  });

  it("listSystemLogs skips the search clause when it sanitizes to nothing", async () => {
    const db = mockDb();
    await listSystemLogs("biz-uuid-1", { search: "%_,()" }, db as never);
    expect(db.or).not.toHaveBeenCalled();
  });

  it("listSystemLogs falls back to the service client when none is passed", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const rows = await listSystemLogs("biz-uuid-1");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([MOCK_ROW]);
  });

  it("listSystemLogs applies source, sanitized search, and before", async () => {
    const db = mockDb();
    await listSystemLogs(
      "biz-uuid-1",
      { source: "aiflow", search: "tel%nyx", before: "2026-06-09T00:00:00Z" },
      db as never
    );
    expect(db.eq).toHaveBeenCalledWith("source", "aiflow");
    expect(db.or).toHaveBeenCalledWith("event.ilike.%telnyx%,message.ilike.%telnyx%");
    expect(db.lt).toHaveBeenCalledWith("created_at", "2026-06-09T00:00:00Z");
  });

  it("listSystemLogs returns [] when the query yields null data", async () => {
    const db = mockDb({ limit: vi.fn().mockResolvedValue({ data: null, error: null }) });
    await expect(listSystemLogs("biz-uuid-1", {}, db as never)).resolves.toEqual([]);
  });

  it("listSystemLogs throws on query error", async () => {
    const db = mockDb({
      limit: vi.fn().mockResolvedValue({ data: null, error: { message: "err" } })
    });
    await expect(listSystemLogs("biz-uuid-1", {}, db as never)).rejects.toThrow(
      "listSystemLogs"
    );
  });

  it("listSystemLogErrorsAll filters level=error and joins business name", async () => {
    const withBiz = { ...MOCK_ROW, businesses: { name: "Acme" } };
    const db = mockDb({ limit: vi.fn().mockResolvedValue({ data: [withBiz], error: null }) });
    const rows = await listSystemLogErrorsAll(10, db as never);
    expect(rows[0].businesses?.name).toBe("Acme");
    expect(db.eq).toHaveBeenCalledWith("level", "error");
    expect(db.select).toHaveBeenCalledWith(expect.stringContaining("businesses(name)"));
  });

  it("listSystemLogErrorsAll falls back to the service client and default limit", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const rows = await listSystemLogErrorsAll();
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    expect(db.limit).toHaveBeenCalledWith(30);
    expect(rows).toEqual([MOCK_ROW]);
  });

  it("listSystemLogErrorsAll returns [] when the query yields null data", async () => {
    const db = mockDb({ limit: vi.fn().mockResolvedValue({ data: null, error: null }) });
    await expect(listSystemLogErrorsAll(5, db as never)).resolves.toEqual([]);
  });

  it("listSystemLogErrorsAll throws on error", async () => {
    const db = mockDb({
      limit: vi.fn().mockResolvedValue({ data: null, error: { message: "err" } })
    });
    await expect(listSystemLogErrorsAll(10, db as never)).rejects.toThrow(
      "listSystemLogErrorsAll"
    );
  });
});
