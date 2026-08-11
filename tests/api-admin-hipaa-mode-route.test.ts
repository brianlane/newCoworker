import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  updateBusinessHipaaMode: vi.fn()
}));

import { POST } from "@/app/api/admin/hipaa-mode/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateBusinessHipaaMode } from "@/lib/db/businesses";
import { HIPAA_TIER_MESSAGE, HipaaValidationError } from "@/lib/hipaa/tier-gate";

const BIZ_ID = "22222222-2222-4222-8222-222222222222";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/hipaa-mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/admin/hipaa-mode route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ_ID, tier: "enterprise" } as never);
    vi.mocked(updateBusinessHipaaMode).mockResolvedValue(undefined);
  });

  it("turns the lane on for an enterprise business", async () => {
    const res = await POST(makeRequest({ businessId: BIZ_ID, enabled: true }));
    expect(res.status).toBe(200);
    expect(updateBusinessHipaaMode).toHaveBeenCalledWith(BIZ_ID, true);
    const json = await res.json();
    expect(json.data).toEqual({ businessId: BIZ_ID, hipaaMode: true });
  });

  it("turns it back off", async () => {
    const res = await POST(makeRequest({ businessId: BIZ_ID, enabled: false }));
    expect(res.status).toBe(200);
    expect(updateBusinessHipaaMode).toHaveBeenCalledWith(BIZ_ID, false);
  });

  it("requires admin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      Object.assign(new Error("Admin access required"), { status: 403 })
    );
    const res = await POST(makeRequest({ businessId: BIZ_ID, enabled: true }));
    expect(res.status).toBe(403);
    expect(updateBusinessHipaaMode).not.toHaveBeenCalled();
  });

  it("404s an unknown business", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    const res = await POST(makeRequest({ businessId: BIZ_ID, enabled: true }));
    expect(res.status).toBe(404);
    expect(updateBusinessHipaaMode).not.toHaveBeenCalled();
  });

  it("surfaces the tier-gate rejection as a validation error", async () => {
    vi.mocked(updateBusinessHipaaMode).mockRejectedValue(
      new HipaaValidationError(HIPAA_TIER_MESSAGE)
    );
    const res = await POST(makeRequest({ businessId: BIZ_ID, enabled: true }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain("Enterprise plan feature");
  });

  it("rejects a malformed body", async () => {
    const res = await POST(makeRequest({ businessId: "not-a-uuid", enabled: true }));
    expect(res.status).toBe(400);
    expect(updateBusinessHipaaMode).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean enabled, so a truthy string cannot switch the lane on", async () => {
    const res = await POST(makeRequest({ businessId: BIZ_ID, enabled: "true" }));
    expect(res.status).toBe(400);
    expect(updateBusinessHipaaMode).not.toHaveBeenCalled();
  });
});
