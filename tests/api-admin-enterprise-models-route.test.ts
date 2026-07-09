import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  updateEnterpriseModels: vi.fn()
}));

import { POST } from "@/app/api/admin/enterprise-models/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateEnterpriseModels } from "@/lib/db/businesses";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/admin/enterprise-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  );
}

describe("api/admin/enterprise-models route", () => {
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
  });

  it("saves model overrides for an enterprise business", async () => {
    const res = await post({
      businessId: BIZ_ID,
      enterpriseModels: { ownerChatModel: "gemini-3.1-flash", voiceName: "Kore" }
    });
    expect(res.status).toBe(200);
    expect(updateEnterpriseModels).toHaveBeenCalledWith(BIZ_ID, {
      ownerChatModel: "gemini-3.1-flash",
      voiceName: "Kore"
    });
  });

  it("clears overrides with null (and normalizes {} to null)", async () => {
    await post({ businessId: BIZ_ID, enterpriseModels: null });
    expect(updateEnterpriseModels).toHaveBeenCalledWith(BIZ_ID, null);

    await post({ businessId: BIZ_ID, enterpriseModels: {} });
    expect(updateEnterpriseModels).toHaveBeenLastCalledWith(BIZ_ID, null);
  });

  it("rejects non-enterprise businesses and missing rows", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ_ID, tier: "standard" } as never);
    const gated = await post({ businessId: BIZ_ID, enterpriseModels: { voiceName: "Puck" } });
    expect(gated.status).toBe(400);
    expect(updateEnterpriseModels).not.toHaveBeenCalled();

    vi.mocked(getBusiness).mockResolvedValue(null);
    const missing = await post({ businessId: BIZ_ID, enterpriseModels: null });
    expect(missing.status).toBe(404);
  });

  it("validates the payload (live model in a chat slot rejected)", async () => {
    const res = await post({
      businessId: BIZ_ID,
      enterpriseModels: { smsChatModel: "gemini-3.1-flash-live-preview" }
    });
    expect(res.status).toBe(400);
    expect(updateEnterpriseModels).not.toHaveBeenCalled();
  });
});
