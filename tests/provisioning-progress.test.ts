import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  recordProvisioningProgress,
  getLatestProvisioningStatus,
  getProvisioningLogs,
  shouldShowProvisioningProgress,
  shouldMountProvisioningWidget,
  isBusinessRunningStatus
} from "@/lib/provisioning/progress";
import { insertCoworkerLog } from "@/lib/db/logs";

vi.mock("@/lib/db/logs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/logs")>();
  return {
    ...actual,
    insertCoworkerLog: vi.fn()
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

describe("provisioning/progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(insertCoworkerLog).mockResolvedValue({
      id: "id-1",
      business_id: "00000000-0000-4000-8000-000000000001",
      task_type: "provisioning",
      status: "thinking",
      log_payload: {},
      created_at: "2026-01-01T00:00:00Z"
    });
  });

  it("recordProvisioningProgress clamps percent and sets thinking for in-flight", async () => {
    await recordProvisioningProgress({
      businessId: "00000000-0000-4000-8000-000000000001",
      phase: "test",
      percent: 33,
      message: "m",
      source: "orchestrator"
    });
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({
        task_type: "provisioning",
        status: "thinking",
        log_payload: expect.objectContaining({ percent: 33 })
      })
    );
  });

  it("recordProvisioningProgress respects explicit success below 100", async () => {
    await recordProvisioningProgress({
      businessId: "00000000-0000-4000-8000-000000000001",
      phase: "x",
      percent: 10,
      message: "m",
      source: "vps",
      status: "success"
    });
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", log_payload: expect.objectContaining({ percent: 10 }) })
    );
  });

  it("recordProvisioningProgress uses explicit error status", async () => {
    await recordProvisioningProgress({
      businessId: "00000000-0000-4000-8000-000000000001",
      phase: "fail",
      percent: 50,
      message: "bad",
      source: "orchestrator",
      status: "error"
    });
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" })
    );
  });

  it("recordProvisioningProgress uses success at 100% without explicit status", async () => {
    await recordProvisioningProgress({
      businessId: "00000000-0000-4000-8000-000000000001",
      phase: "done",
      percent: 100,
      message: "ok",
      source: "vps"
    });
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" })
    );
  });

  it("isBusinessRunningStatus is true for online and high_load only", () => {
    expect(isBusinessRunningStatus("online")).toBe(true);
    expect(isBusinessRunningStatus("high_load")).toBe(true);
    expect(isBusinessRunningStatus("offline")).toBe(false);
  });

  it("shouldShowProvisioningProgress hides when online with no logs", () => {
    expect(shouldShowProvisioningProgress("online", null)).toBe(false);
  });

  it("shouldShowProvisioningProgress hides when high_load with no logs", () => {
    expect(shouldShowProvisioningProgress("high_load", null)).toBe(false);
  });

  it("shouldShowProvisioningProgress hides when online and percent complete", () => {
    expect(
      shouldShowProvisioningProgress("online", {
        percent: 100,
        updatedAt: "x",
        phase: "done",
        logStatus: "success"
      })
    ).toBe(false);
  });

  it("shouldShowProvisioningProgress hides when high_load and percent complete", () => {
    expect(
      shouldShowProvisioningProgress("high_load", {
        percent: 100,
        updatedAt: "x",
        phase: "done",
        logStatus: "success"
      })
    ).toBe(false);
  });

  it("shouldShowProvisioningProgress hides when online at partial percent but log status is error", () => {
    expect(
      shouldShowProvisioningProgress("online", {
        percent: 95,
        updatedAt: "x",
        phase: "deploy_failed",
        logStatus: "error"
      })
    ).toBe(false);
  });

  it("shouldMountProvisioningWidget stays true for terminal error so owner sees failure UI", () => {
    const latest = {
      percent: 95,
      updatedAt: "x",
      phase: "deploy_failed",
      logStatus: "error" as const
    };
    expect(shouldShowProvisioningProgress("online", latest)).toBe(false);
    expect(shouldMountProvisioningWidget("online", latest)).toBe(true);
  });

  it("shouldMountProvisioningWidget delegates to shouldShowProvisioningProgress when latest is not error", () => {
    expect(shouldMountProvisioningWidget("online", null)).toBe(false);
    expect(
      shouldMountProvisioningWidget("online", {
        percent: 50,
        updatedAt: "x",
        phase: "x",
        logStatus: "thinking"
      })
    ).toBe(true);
    expect(
      shouldMountProvisioningWidget("online", {
        percent: 100,
        updatedAt: "x",
        phase: "done",
        logStatus: "success"
      })
    ).toBe(false);
    expect(shouldMountProvisioningWidget("offline", null)).toBe(true);
  });

  it("shouldShowProvisioningProgress shows when offline", () => {
    expect(shouldShowProvisioningProgress("offline", null)).toBe(true);
  });

  it("shouldShowProvisioningProgress shows when online but not complete", () => {
    expect(
      shouldShowProvisioningProgress("online", {
        percent: 50,
        updatedAt: "x",
        phase: "x",
        logStatus: "thinking"
      })
    ).toBe(true);
  });

  it("shouldShowProvisioningProgress shows when high_load but not complete", () => {
    expect(
      shouldShowProvisioningProgress("high_load", {
        percent: 50,
        updatedAt: "x",
        phase: "x",
        logStatus: "thinking"
      })
    ).toBe(true);
  });

  it("shouldShowProvisioningProgress treats missing percent as 0 for online", () => {
    const latest = {
      updatedAt: "x",
      phase: "x"
    } as unknown as import("@/lib/provisioning/progress").LatestProvisioningStatus;
    expect(shouldShowProvisioningProgress("online", latest)).toBe(true);
  });

  it("getLatestProvisioningStatus returns null when no row", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getLatestProvisioningStatus("00000000-0000-4000-8000-000000000001")).resolves.toBeNull();
  });

  it("getLatestProvisioningStatus throws on db error", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "db fail" } })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getLatestProvisioningStatus("00000000-0000-4000-8000-000000000001")).rejects.toThrow(
      "getLatestProvisioningStatus"
    );
  });

  it("getLatestProvisioningStatus coerces invalid percent and phase", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          log_payload: {
            phase: 123,
            percent: "nope",
            message: "m",
            source: "vps"
          },
          created_at: "2026-01-01T00:00:00Z",
          status: "thinking"
        },
        error: null
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const s = await getLatestProvisioningStatus("00000000-0000-4000-8000-000000000001");
    expect(s?.percent).toBe(0);
    expect(s?.phase).toBe("");
    expect(s?.logStatus).toBe("thinking");
  });

  it("getLatestProvisioningStatus maps payload", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          log_payload: {
            phase: "p",
            percent: 42,
            message: "m",
            source: "vps"
          },
          created_at: "2026-06-01T12:00:00Z",
          status: "success"
        },
        error: null
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const s = await getLatestProvisioningStatus("00000000-0000-4000-8000-000000000001");
    expect(s).toEqual({
      percent: 42,
      updatedAt: "2026-06-01T12:00:00Z",
      phase: "p",
      logStatus: "success"
    });
  });

  it("getLatestProvisioningStatus maps error row status", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          log_payload: {
            phase: "deploy_failed",
            percent: 95,
            message: "x",
            source: "orchestrator"
          },
          created_at: "2026-06-01T12:00:00Z",
          status: "error"
        },
        error: null
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const s = await getLatestProvisioningStatus("00000000-0000-4000-8000-000000000001");
    expect(s?.logStatus).toBe("error");
    expect(s?.percent).toBe(95);
  });

  it("getLatestProvisioningStatus maps urgent_alert row status", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          log_payload: {
            phase: "p",
            percent: 10,
            message: "m",
            source: "vps"
          },
          created_at: "2026-06-01T12:00:00Z",
          status: "urgent_alert"
        },
        error: null
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const s = await getLatestProvisioningStatus("00000000-0000-4000-8000-000000000001");
    expect(s?.logStatus).toBe("urgent_alert");
  });

  it("getLatestProvisioningStatus normalizes unknown row status to thinking", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          log_payload: {
            phase: "p",
            percent: 1,
            message: "m",
            source: "vps"
          },
          created_at: "2026-01-01T00:00:00Z",
          status: "unexpected_value"
        },
        error: null
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const s = await getLatestProvisioningStatus("00000000-0000-4000-8000-000000000001");
    expect(s?.logStatus).toBe("thinking");
  });

  it("getLatestProvisioningStatus treats omitted status as thinking", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          log_payload: {
            phase: "p",
            percent: 2,
            message: "m",
            source: "vps"
          },
          created_at: "2026-01-01T00:00:00Z"
        },
        error: null
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const s = await getLatestProvisioningStatus("00000000-0000-4000-8000-000000000001");
    expect(s?.logStatus).toBe("thinking");
  });

  it("getProvisioningLogs returns rows", async () => {
    const row = {
      id: "l1",
      business_id: "00000000-0000-4000-8000-000000000001",
      task_type: "provisioning",
      status: "thinking",
      log_payload: {},
      created_at: "2026-01-01T00:00:00Z"
    };
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [row], error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const logs = await getProvisioningLogs("00000000-0000-4000-8000-000000000001", 10);
    expect(logs).toEqual([row]);
  });

  it("getProvisioningLogs returns empty when data is null without error", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getProvisioningLogs("00000000-0000-4000-8000-000000000001")).resolves.toEqual([]);
  });

  it("getProvisioningLogs throws on error", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: null, error: { message: "e" } })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getProvisioningLogs("00000000-0000-4000-8000-000000000001")).rejects.toThrow(
      "getProvisioningLogs"
    );
  });
});
