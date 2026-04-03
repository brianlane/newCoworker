import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BusinessRow } from "@/lib/db/businesses";

vi.mock("@/lib/auth", () => ({
  requireOwner: vi.fn().mockResolvedValue({})
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/provisioning/progress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/provisioning/progress")>();
  return {
    ...actual,
    getLatestProvisioningStatus: vi.fn()
  };
});

import { GET } from "@/app/api/provisioning/status/route";
import { getBusiness } from "@/lib/db/businesses";
import { getLatestProvisioningStatus } from "@/lib/provisioning/progress";

const BID = "00000000-0000-4000-8000-000000000001";

function mockBusiness(status: BusinessRow["status"]): BusinessRow {
  return {
    id: BID,
    name: "Test",
    owner_email: "a@b.com",
    tier: "starter",
    status,
    hostinger_vps_id: null,
    created_at: "2026-01-01T00:00:00Z"
  };
}

describe("GET /api/provisioning/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets complete true for high_load with no provisioning rows (aligns with shouldShowProvisioningProgress)", async () => {
    vi.mocked(getBusiness).mockResolvedValue(mockBusiness("high_load"));
    vi.mocked(getLatestProvisioningStatus).mockResolvedValue(null);

    const res = await GET(
      new Request(`http://localhost/api/provisioning/status?businessId=${BID}`)
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { complete: boolean; percent: number } };
    expect(json.ok).toBe(true);
    expect(json.data.complete).toBe(true);
    expect(json.data.percent).toBe(0);
  });

  it("sets complete true for high_load when latest percent is 100", async () => {
    vi.mocked(getBusiness).mockResolvedValue(mockBusiness("high_load"));
    vi.mocked(getLatestProvisioningStatus).mockResolvedValue({
      percent: 100,
      updatedAt: "2026-01-01T00:00:00Z",
      phase: "done",
      logStatus: "success"
    });

    const res = await GET(
      new Request(`http://localhost/api/provisioning/status?businessId=${BID}`)
    );
    const json = (await res.json()) as { ok: boolean; data: { complete: boolean } };
    expect(json.data.complete).toBe(true);
  });

  it("sets complete false for high_load when provisioning still in progress", async () => {
    vi.mocked(getBusiness).mockResolvedValue(mockBusiness("high_load"));
    vi.mocked(getLatestProvisioningStatus).mockResolvedValue({
      percent: 40,
      updatedAt: "2026-01-01T00:00:00Z",
      phase: "deploy",
      logStatus: "thinking"
    });

    const res = await GET(
      new Request(`http://localhost/api/provisioning/status?businessId=${BID}`)
    );
    const json = (await res.json()) as { ok: boolean; data: { complete: boolean; failed: boolean } };
    expect(json.data.complete).toBe(false);
    expect(json.data.failed).toBe(false);
  });

  it("sets complete and failed when latest provisioning row is error (e.g. deploy-client.sh failed)", async () => {
    vi.mocked(getBusiness).mockResolvedValue(mockBusiness("online"));
    vi.mocked(getLatestProvisioningStatus).mockResolvedValue({
      percent: 95,
      updatedAt: "2026-01-01T00:00:00Z",
      phase: "deploy_failed",
      logStatus: "error"
    });

    const res = await GET(
      new Request(`http://localhost/api/provisioning/status?businessId=${BID}`)
    );
    const json = (await res.json()) as { ok: boolean; data: { complete: boolean; failed: boolean } };
    expect(json.data.complete).toBe(true);
    expect(json.data.failed).toBe(true);
  });
});
