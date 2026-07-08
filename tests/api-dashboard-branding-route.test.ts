import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireBusinessRole: vi.fn(),
  getAuthUser: vi.fn()
}));

vi.mock("@/lib/admin/view-as", () => ({
  isViewAsActive: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  updateBusinessBranding: vi.fn()
}));

import { GET, POST } from "@/app/api/dashboard/branding/route";
import { requireBusinessRole, getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { getBusiness, updateBusinessBranding } from "@/lib/db/businesses";

const BIZ = "11111111-1111-4111-8111-111111111111";

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/dashboard/branding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  );
}

describe("api/dashboard/branding route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireBusinessRole).mockResolvedValue({
      userId: "u-1",
      email: "owner@example.com",
      isAdmin: false
    } as never);
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u-1",
      email: "owner@example.com",
      isAdmin: false
    } as never);
    vi.mocked(isViewAsActive).mockResolvedValue(false);
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      tier: "enterprise",
      branding: { productName: "Acme" }
    } as never);
  });

  it("GET returns the parsed stored branding behind manage_settings", async () => {
    const res = await GET(new Request(`http://localhost/api/dashboard/branding?businessId=${BIZ}`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.branding).toEqual({ productName: "Acme" });
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_settings");
  });

  it("GET 404s on a missing business and validates the query", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    const missing = await GET(
      new Request(`http://localhost/api/dashboard/branding?businessId=${BIZ}`)
    );
    expect(missing.status).toBe(404);

    const invalid = await GET(new Request("http://localhost/api/dashboard/branding?businessId=x"));
    expect(invalid.status).toBe(400);
  });

  it("POST saves valid branding for enterprise businesses", async () => {
    const res = await post({
      businessId: BIZ,
      branding: { productName: "Acme Assistant", accentColor: "#0f0" }
    });
    expect(res.status).toBe(200);
    expect(updateBusinessBranding).toHaveBeenCalledWith(BIZ, {
      productName: "Acme Assistant",
      accentColor: "#0f0"
    });
  });

  it("POST normalizes an empty object to null (clears branding)", async () => {
    const res = await post({ businessId: BIZ, branding: {} });
    expect(res.status).toBe(200);
    expect(updateBusinessBranding).toHaveBeenCalledWith(BIZ, null);
  });

  it("POST refuses setting branding on non-enterprise tiers but allows clearing", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ, tier: "standard" } as never);
    const gated = await post({ businessId: BIZ, branding: { productName: "Acme" } });
    expect(gated.status).toBe(403);
    expect(updateBusinessBranding).not.toHaveBeenCalled();

    const cleared = await post({ businessId: BIZ, branding: null });
    expect(cleared.status).toBe(200);
    expect(updateBusinessBranding).toHaveBeenCalledWith(BIZ, null);
  });

  it("POST refuses view-as writes and validates payloads", async () => {
    vi.mocked(isViewAsActive).mockResolvedValue(true);
    const viewAs = await post({ businessId: BIZ, branding: null });
    expect(viewAs.status).toBe(403);

    vi.mocked(isViewAsActive).mockResolvedValue(false);
    const badLogo = await post({
      businessId: BIZ,
      branding: { logoUrl: "http://insecure.example.com/logo.png" }
    });
    expect(badLogo.status).toBe(400);
  });

  it("POST 404s when the business row is missing", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    const res = await post({ businessId: BIZ, branding: null });
    expect(res.status).toBe(404);
  });
});
