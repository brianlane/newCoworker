import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

// Keep ByonValidationError real — the route branches on `instanceof`.
vi.mock("@/lib/byon/port-requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/byon/port-requests")>();
  return { ...actual, runPortabilityCheck: vi.fn() };
});

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 }))
}));

vi.mock("@/lib/byon/tier-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/byon/tier-gate")>();
  return { ...actual, assertByonAllowedForBusiness: vi.fn() };
});

import { POST } from "@/app/api/dashboard/byon/check/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { ByonValidationError, runPortabilityCheck } from "@/lib/byon/port-requests";
import { assertByonAllowedForBusiness, BYON_UPGRADE_MESSAGE } from "@/lib/byon/tier-gate";
import { rateLimit } from "@/lib/rate-limit";

const OWNER = { userId: "u-1", email: "owner@example.com", isAdmin: false };
const BIZ = "11111111-1111-4111-8111-111111111111";

function req(body: unknown) {
  return new Request("http://localhost/api/dashboard/byon/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/dashboard/byon/check route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
    vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
    vi.mocked(rateLimit).mockReturnValue({ success: true, limit: 10, remaining: 9, reset: 0 } as never);
    vi.mocked(assertByonAllowedForBusiness).mockResolvedValue(undefined);
  });

  it("401 when not signed in", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await POST(req({ businessId: BIZ, phone: "+13125550001" }));
    expect(res.status).toBe(401);
  });

  it("400 on invalid body", async () => {
    const res = await POST(req({ businessId: "not-a-uuid", phone: "+13125550001" }));
    expect(res.status).toBe(400);
  });

  it("admin bypasses requireBusinessRole", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ ...OWNER, isAdmin: true } as never);
    vi.mocked(runPortabilityCheck).mockResolvedValue({ portable: true } as never);
    const res = await POST(req({ businessId: BIZ, phone: "+13125550001" }));
    expect(res.status).toBe(200);
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });

  it("429 when rate limited", async () => {
    vi.mocked(rateLimit).mockReturnValue({ success: false } as never);
    const res = await POST(req({ businessId: BIZ, phone: "+13125550001" }));
    expect(res.status).toBe(429);
  });

  it("returns the check summary for the owner", async () => {
    vi.mocked(runPortabilityCheck).mockResolvedValue({
      phoneE164: "+13125550001",
      portable: true,
      fastPortable: true,
      etaDays: "1-4 business days",
      notPortableReason: null,
      carrierName: null
    });
    const res = await POST(req({ businessId: BIZ, phone: "312-555-0001" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.check.etaDays).toBe("1-4 business days");
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_settings");
    expect(runPortabilityCheck).toHaveBeenCalledWith("312-555-0001");
  });

  it("400 with the upgrade prompt for starter-tier businesses", async () => {
    vi.mocked(assertByonAllowedForBusiness).mockRejectedValueOnce(
      new ByonValidationError(BYON_UPGRADE_MESSAGE)
    );
    const res = await POST(req({ businessId: BIZ, phone: "+13125550001" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.message).toBe(BYON_UPGRADE_MESSAGE);
    expect(runPortabilityCheck).not.toHaveBeenCalled();
  });

  it("maps ByonValidationError to a 400 with the message", async () => {
    vi.mocked(runPortabilityCheck).mockRejectedValue(
      new ByonValidationError("Short codes can't be ported — enter a full phone number.")
    );
    const res = await POST(req({ businessId: BIZ, phone: "12345" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.message).toContain("Short codes");
  });

  it("500 on unexpected errors", async () => {
    vi.mocked(runPortabilityCheck).mockRejectedValue(new Error("telnyx down"));
    const res = await POST(req({ businessId: BIZ, phone: "+13125550001" }));
    expect(res.status).toBe(500);
  });
});
