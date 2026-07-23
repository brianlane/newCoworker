import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({
  assertCronAuth: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({
  listBusinessesWithRetention: vi.fn()
}));
vi.mock("@/lib/privacy/retention", () => ({
  pruneExpiredContent: vi.fn()
}));
vi.mock("@/lib/memory/kg-events", () => ({
  pruneKgRetrievalEvents: vi.fn(async () => 0)
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { POST } from "@/app/api/internal/data-retention-sweep/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { listBusinessesWithRetention } from "@/lib/db/businesses";
import { pruneExpiredContent } from "@/lib/privacy/retention";
import { pruneKgRetrievalEvents } from "@/lib/memory/kg-events";

function makeRequest(): Request {
  return new Request("http://localhost/api/internal/data-retention-sweep", {
    method: "POST",
    headers: { Authorization: "Bearer secret" }
  });
}

describe("api/internal/data-retention-sweep route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertCronAuth).mockReturnValue(true);
  });

  it("rejects bad cron bearers", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
  });

  it("prunes every configured tenant and sums the counts", async () => {
    vi.mocked(listBusinessesWithRetention).mockResolvedValue([
      { id: "biz-1", data_retention_days: 90 },
      { id: "biz-2", data_retention_days: 30 }
    ]);
    vi.mocked(pruneExpiredContent).mockResolvedValue({
      businessId: "x",
      retentionDays: 90,
      cutoffIso: "c",
      tables: [
        { table: "email_log", central: 2, box: 1 },
        { table: "sms_outbound_log", central: 3, box: null }
      ]
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({
      targets: 2,
      pruned: 2,
      centralRows: 10,
      boxRows: 2,
      errors: []
    });
    expect(pruneExpiredContent).toHaveBeenCalledWith("biz-1", 90);
    expect(pruneExpiredContent).toHaveBeenCalledWith("biz-2", 30);
  });

  it("captures per-tenant failures and continues", async () => {
    vi.mocked(listBusinessesWithRetention).mockResolvedValue([
      { id: "biz-1", data_retention_days: 90 },
      { id: "biz-2", data_retention_days: 30 }
    ]);
    vi.mocked(pruneExpiredContent)
      .mockRejectedValueOnce(new Error("box down"))
      .mockResolvedValueOnce({
        businessId: "biz-2",
        retentionDays: 30,
        cutoffIso: "c",
        tables: [{ table: "email_log", central: 1, box: 0 }]
      });
    const res = await POST(makeRequest());
    const json = await res.json();
    expect(json.data.pruned).toBe(1);
    expect(json.data.errors).toEqual([{ businessId: "biz-1", message: "box down" }]);
  });

  it("prunes the KG comparison ledger on its fixed window and reports the count", async () => {
    vi.mocked(listBusinessesWithRetention).mockResolvedValue([]);
    vi.mocked(pruneKgRetrievalEvents).mockResolvedValue(42);
    const res = await POST(makeRequest());
    const json = await res.json();
    expect(json.data.kgEventsPruned).toBe(42);
    expect(pruneKgRetrievalEvents).toHaveBeenCalledTimes(1);
  });

  it("captures a KG-ledger prune failure without failing the sweep (non-Error too)", async () => {
    vi.mocked(listBusinessesWithRetention).mockResolvedValue([]);
    vi.mocked(pruneKgRetrievalEvents).mockRejectedValueOnce(new Error("locked"));
    const res = await POST(makeRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.kgEventsPruned).toBe(0);
    expect(json.data.errors).toEqual([
      { businessId: "platform:kg_retrieval_events", message: "locked" }
    ]);

    vi.mocked(pruneKgRetrievalEvents).mockRejectedValueOnce("string failure");
    const res2 = await POST(makeRequest());
    const json2 = await res2.json();
    expect(json2.data.errors[0].message).toBe("string failure");
  });

  it("500s when the target list itself cannot be read", async () => {
    vi.mocked(listBusinessesWithRetention).mockRejectedValue(new Error("db down"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
  });
});
