import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({
  MIN_DATA_RETENTION_DAYS: 30,
  getBusiness: vi.fn(),
  updateDataRetentionDays: vi.fn()
}));
vi.mock("@/lib/db/logs", () => ({
  insertCoworkerLog: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { POST } from "@/app/api/admin/data-retention/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateDataRetentionDays } from "@/lib/db/businesses";
import { insertCoworkerLog } from "@/lib/db/logs";
import { logger } from "@/lib/logger";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/data-retention", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/admin/data-retention route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({ isAdmin: true } as never);
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ_ID,
      data_retention_days: null
    } as never);
    vi.mocked(updateDataRetentionDays).mockResolvedValue(undefined);
    vi.mocked(insertCoworkerLog).mockResolvedValue({} as never);
  });

  it("sets a retention window and audit-logs the change", async () => {
    const res = await POST(makeRequest({ businessId: BIZ_ID, retentionDays: 90 }));
    expect(res.status).toBe(200);
    expect(updateDataRetentionDays).toHaveBeenCalledWith(BIZ_ID, 90);
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ_ID,
        task_type: "data_flow",
        log_payload: expect.objectContaining({
          action: "data_retention_updated",
          retentionDays: 90,
          previous: null
        })
      })
    );
    const json = await res.json();
    expect(json.data.note).toContain("90 days");
  });

  it("null clears the window", async () => {
    const res = await POST(makeRequest({ businessId: BIZ_ID, retentionDays: null }));
    expect(res.status).toBe(200);
    expect(updateDataRetentionDays).toHaveBeenCalledWith(BIZ_ID, null);
    const json = await res.json();
    expect(json.data.note).toContain("kept forever");
  });

  it("rejects sub-floor windows and missing businesses", async () => {
    const low = await POST(makeRequest({ businessId: BIZ_ID, retentionDays: 7 }));
    expect(low.status).toBe(400);
    expect(updateDataRetentionDays).not.toHaveBeenCalled();

    vi.mocked(getBusiness).mockResolvedValue(null);
    const missing = await POST(makeRequest({ businessId: BIZ_ID, retentionDays: 90 }));
    expect(missing.status).toBe(404);
  });

  it("a failed audit insert warns but does not fail the change", async () => {
    vi.mocked(insertCoworkerLog).mockRejectedValue(new Error("logs down"));
    const res = await POST(makeRequest({ businessId: BIZ_ID, retentionDays: 30 }));
    expect(res.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("audit log insert failed"),
      expect.objectContaining({ error: "logs down" })
    );
  });

  it("unexpected failures surface as 500", async () => {
    vi.mocked(updateDataRetentionDays).mockRejectedValue(new Error("db down"));
    const res = await POST(makeRequest({ businessId: BIZ_ID, retentionDays: 90 }));
    expect(res.status).toBe(500);
  });
});
