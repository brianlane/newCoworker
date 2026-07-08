import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/byon/loa-pdf", () => ({
  generateLoaPdf: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])) // %PDF-
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true }))
}));

vi.mock("@/lib/byon/tier-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/byon/tier-gate")>();
  return { ...actual, assertByonAllowedForBusiness: vi.fn() };
});

import { POST } from "@/app/api/dashboard/byon/loa/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { generateLoaPdf } from "@/lib/byon/loa-pdf";
import { ByonValidationError } from "@/lib/byon/port-requests";
import { assertByonAllowedForBusiness, BYON_UPGRADE_MESSAGE } from "@/lib/byon/tier-gate";
import { rateLimit } from "@/lib/rate-limit";

const OWNER = { userId: "u-1", email: "owner@example.com", isAdmin: false };
const BIZ = "11111111-1111-4111-8111-111111111111";

function validBody() {
  return {
    businessId: BIZ,
    phone: "312-555-0001",
    carrier: { entityName: "Acme LLC", authorizedName: "Jane Doe", accountNumber: "ACC-42" },
    serviceAddress: { street: "311 W Superior St", city: "Chicago", state: "IL", zip: "60654" },
    carrierName: "Old Carrier"
  };
}

function req(body: unknown) {
  return new Request("http://localhost/api/dashboard/byon/loa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/dashboard/byon/loa route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
    vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
    vi.mocked(rateLimit).mockReturnValue({ success: true } as never);
    vi.mocked(assertByonAllowedForBusiness).mockResolvedValue(undefined);
  });

  it("401 when not signed in, 400 on invalid body, 429 when limited", async () => {
    vi.mocked(getAuthUser).mockResolvedValueOnce(null);
    expect((await POST(req(validBody()))).status).toBe(401);

    expect((await POST(req({ ...validBody(), carrier: {} }))).status).toBe(400);

    vi.mocked(rateLimit).mockReturnValueOnce({ success: false } as never);
    expect((await POST(req(validBody()))).status).toBe(429);
  });

  it("400 on unparseable phone numbers and short codes", async () => {
    expect((await POST(req({ ...validBody(), phone: "hello" }))).status).toBe(400);
    const res = await POST(req({ ...validBody(), phone: "12345" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("full phone number");
  });

  it("400 with the upgrade prompt for starter-tier businesses", async () => {
    vi.mocked(assertByonAllowedForBusiness).mockRejectedValueOnce(
      new ByonValidationError(BYON_UPGRADE_MESSAGE)
    );
    const res = await POST(req(validBody()));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.message).toBe(BYON_UPGRADE_MESSAGE);
    expect(generateLoaPdf).not.toHaveBeenCalled();
  });

  it("returns the prefilled PDF as a download (admin bypasses requireBusinessRole)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ ...OWNER, isAdmin: true } as never);
    const res = await POST(req(validBody()));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("letter-of-authorization.pdf");
    expect(requireBusinessRole).not.toHaveBeenCalled();
    expect(generateLoaPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneE164: "+13125550001",
        entityName: "Acme LLC",
        carrierName: "Old Carrier"
      })
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(String.fromCharCode(...bytes)).toBe("%PDF-");
  });

  it("500 when generation fails", async () => {
    vi.mocked(generateLoaPdf).mockRejectedValueOnce(new Error("pdf broke"));
    expect((await POST(req(validBody()))).status).toBe(500);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_settings");
  });
});
