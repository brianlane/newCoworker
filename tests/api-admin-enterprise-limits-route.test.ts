import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  updateEnterpriseLimits: vi.fn()
}));

import { POST } from "@/app/api/admin/enterprise-limits/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateEnterpriseLimits } from "@/lib/db/businesses";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

describe("api/admin/enterprise-limits route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
  });

  it("updates limits for an enterprise business", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ_ID,
      name: "Corp",
      owner_email: "o@o.com",
      tier: "enterprise",
      status: "online",
      hostinger_vps_id: null,
      created_at: "2026-01-01T00:00:00Z"
    });
    vi.mocked(updateEnterpriseLimits).mockResolvedValue(undefined);

    const response = await POST(
      new Request("http://localhost/api/admin/enterprise-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ_ID,
          enterpriseLimits: { voiceIncludedSecondsPerStripePeriod: 200_000 }
        })
      })
    );

    expect(response.status).toBe(200);
    expect(updateEnterpriseLimits).toHaveBeenCalledWith(BIZ_ID, {
      voiceIncludedSecondsPerStripePeriod: 200_000
    });
  });

  it("clears overrides when enterpriseLimits is null", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ_ID,
      name: "Corp",
      owner_email: "o@o.com",
      tier: "enterprise",
      status: "online",
      hostinger_vps_id: null,
      created_at: "2026-01-01T00:00:00Z"
    });

    const response = await POST(
      new Request("http://localhost/api/admin/enterprise-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: BIZ_ID, enterpriseLimits: null })
      })
    );

    expect(response.status).toBe(200);
    expect(updateEnterpriseLimits).toHaveBeenCalledWith(BIZ_ID, null);
  });

  it("returns NOT_FOUND when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost/api/admin/enterprise-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ_ID,
          enterpriseLimits: { maxConcurrentCalls: 5 }
        })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("rejects non-enterprise businesses", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ_ID,
      name: "Small",
      owner_email: "o@o.com",
      tier: "starter",
      status: "online",
      hostinger_vps_id: null,
      created_at: "2026-01-01T00:00:00Z"
    });

    const response = await POST(
      new Request("http://localhost/api/admin/enterprise-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ_ID,
          enterpriseLimits: { maxConcurrentCalls: 5 }
        })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("validates enterprise limit fields", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ_ID,
      name: "Corp",
      owner_email: "o@o.com",
      tier: "enterprise",
      status: "online",
      hostinger_vps_id: null,
      created_at: "2026-01-01T00:00:00Z"
    });

    const response = await POST(
      new Request("http://localhost/api/admin/enterprise-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ_ID,
          enterpriseLimits: { voiceIncludedSecondsPerStripePeriod: 30 }
        })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});
