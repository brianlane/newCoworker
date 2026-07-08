import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  updateBusinessVpsProvider: vi.fn()
}));

import { POST } from "@/app/api/admin/vps-provider/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateBusinessVpsProvider } from "@/lib/db/businesses";
import { VpsProviderValidationError } from "@/lib/vps/provider";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/vps-provider", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/admin/vps-provider route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({ isAdmin: true } as never);
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ_ID,
      tier: "enterprise",
      hostinger_vps_id: null,
      vps_provider: "hostinger"
    } as never);
    vi.mocked(updateBusinessVpsProvider).mockResolvedValue(undefined);
  });

  it("pins an unprovisioned enterprise business to ovh/ca", async () => {
    const res = await POST(makeRequest({ businessId: BIZ_ID, provider: "ovh", region: "ca" }));
    expect(res.status).toBe(200);
    expect(updateBusinessVpsProvider).toHaveBeenCalledWith(BIZ_ID, "ovh", "ca");
  });

  it("refuses a provider SWITCH while a box exists, but allows a region-only change", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ_ID,
      tier: "enterprise",
      hostinger_vps_id: "1806097",
      vps_provider: "hostinger"
    } as never);

    const switched = await POST(
      makeRequest({ businessId: BIZ_ID, provider: "ovh", region: "ca" })
    );
    expect(switched.status).toBe(409);
    expect(updateBusinessVpsProvider).not.toHaveBeenCalled();

    const regionOnly = await POST(
      makeRequest({ businessId: BIZ_ID, provider: "hostinger", region: "ca" })
    );
    expect(regionOnly.status).toBe(200);
    expect(updateBusinessVpsProvider).toHaveBeenCalledWith(BIZ_ID, "hostinger", "ca");
  });

  it("surfaces the enterprise tier gate as a 400", async () => {
    vi.mocked(updateBusinessVpsProvider).mockRejectedValue(
      new VpsProviderValidationError("Bring-your-own-server and Canada-region hosting are Enterprise plan features.")
    );
    const res = await POST(makeRequest({ businessId: BIZ_ID, provider: "ovh", region: "ca" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain("Enterprise");
  });

  it("rejects unknown providers/regions and missing businesses", async () => {
    const badProvider = await POST(
      makeRequest({ businessId: BIZ_ID, provider: "aws", region: "ca" })
    );
    expect(badProvider.status).toBe(400);

    vi.mocked(getBusiness).mockResolvedValue(null);
    const missing = await POST(
      makeRequest({ businessId: BIZ_ID, provider: "ovh", region: "ca" })
    );
    expect(missing.status).toBe(404);
  });

  it("unexpected failures collapse to a 500", async () => {
    vi.mocked(updateBusinessVpsProvider).mockRejectedValue(new Error("db down"));
    const res = await POST(makeRequest({ businessId: BIZ_ID, provider: "ovh", region: "ca" }));
    expect(res.status).toBe(500);
  });
});
