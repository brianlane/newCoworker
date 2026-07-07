import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  updateDataResidencyMode: vi.fn()
}));

import { POST } from "@/app/api/admin/data-residency/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateDataResidencyMode } from "@/lib/db/businesses";
import { ResidencyValidationError } from "@/lib/residency/tier-gate";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/data-residency", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/admin/data-residency route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ_ID,
      tier: "enterprise"
    } as never);
    vi.mocked(updateDataResidencyMode).mockResolvedValue(undefined);
  });

  it("flips the mode for an enterprise business", async () => {
    const res = await POST(makeRequest({ businessId: BIZ_ID, mode: "dual" }));
    expect(res.status).toBe(200);
    expect(updateDataResidencyMode).toHaveBeenCalledWith(BIZ_ID, "dual");
  });

  it("surfaces the tier-gate rejection as a validation error", async () => {
    vi.mocked(updateDataResidencyMode).mockRejectedValue(
      new ResidencyValidationError("Data residency is an Enterprise plan feature.")
    );
    const res = await POST(makeRequest({ businessId: BIZ_ID, mode: "vps" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain("Enterprise plan feature");
  });

  it("rejects unknown modes", async () => {
    const res = await POST(makeRequest({ businessId: BIZ_ID, mode: "purged" }));
    expect(res.status).toBe(400);
    expect(updateDataResidencyMode).not.toHaveBeenCalled();
  });

  it("404s when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    const res = await POST(makeRequest({ businessId: BIZ_ID, mode: "dual" }));
    expect(res.status).toBe(404);
    expect(updateDataResidencyMode).not.toHaveBeenCalled();
  });
});
