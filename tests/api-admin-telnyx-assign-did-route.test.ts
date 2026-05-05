import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/telnyx/numbers", () => ({
  TelnyxNumbersClient: class TelnyxNumbersClient {}
}));

vi.mock("@/lib/telnyx/assign-did", () => ({
  assignExistingDidToBusiness: vi.fn(),
  normalizeE164: (n: string) => {
    const digits = n.replace(/[^\d+]/g, "");
    if (!digits.startsWith("+")) throw new Error("normalizeE164: invalid");
    return digits;
  }
}));

import { POST } from "@/app/api/admin/telnyx/assign-did/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { assignExistingDidToBusiness } from "@/lib/telnyx/assign-did";

const BIZ = "11111111-1111-4111-8111-111111111111";

function request(body: unknown): Request {
  return new Request("http://test/api/admin/telnyx/assign-did", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

const ORIGINAL_ENV = process.env;

describe("POST /api/admin/telnyx/assign-did — platform-defaults assertion guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      TELNYX_API_KEY: "key",
      TELNYX_CONNECTION_ID: "mock_conn",
      TELNYX_MESSAGING_PROFILE_ID: "mock_prof"
    };
    vi.mocked(requireAdmin).mockResolvedValue({} as never);
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ, name: "Corp" } as never);
    vi.mocked(assignExistingDidToBusiness).mockResolvedValue({
      route: { to_e164: "+15550009999" },
      settings: {}
    } as never);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("happy path with associate=true (default): platform defaults present, PATCH proceeds", async () => {
    const res = await POST(request({ businessId: BIZ, toE164: "+15550009999" }));
    expect(res.status).toBe(200);
    expect(assignExistingDidToBusiness).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        toE164: "+15550009999",
        associateWithPlatform: true,
        platformDefaults: expect.objectContaining({
          connectionId: "mock_conn"
        })
      }),
      expect.objectContaining({ telnyxNumbers: expect.any(Object) })
    );
  });

  it("returns 400 VALIDATION_ERROR with associate=true and TELNYX_CONNECTION_ID unset — won't PATCH a number into a void", async () => {
    delete process.env.TELNYX_CONNECTION_ID;
    const res = await POST(
      request({ businessId: BIZ, toE164: "+15550009999", associateWithPlatform: true })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toMatch(/connectionId/);
    expect(assignExistingDidToBusiness).not.toHaveBeenCalled();
  });

  it("PERMITS associate=false even when platform defaults are unset — manual reroute path must stay open for recovery", async () => {
    // The May 2026 outage was recovered by an admin manually re-binding
    // (602) 805-3377 directly via the Telnyx API + updating DB rows.
    // Forcing `associate=false` admin actions to also have
    // TELNYX_CONNECTION_ID would block exactly the recovery
    // workflow that exists to fix that scenario.
    delete process.env.TELNYX_CONNECTION_ID;
    delete process.env.TELNYX_MESSAGING_PROFILE_ID;
    const res = await POST(
      request({
        businessId: BIZ,
        toE164: "+15550009999",
        associateWithPlatform: false
      })
    );
    expect(res.status).toBe(200);
    expect(assignExistingDidToBusiness).toHaveBeenCalledWith(
      expect.objectContaining({
        associateWithPlatform: false
      }),
      // No telnyx client passed when associate=false — DB-only update.
      { telnyxNumbers: undefined }
    );
  });

  it("returns 404 when business is not found", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce(null);
    const res = await POST(request({ businessId: BIZ, toE164: "+15550009999" }));
    expect(res.status).toBe(404);
  });

  it("returns 400 when TELNYX_API_KEY is missing on associate=true — pre-existing guard, kept intact by the assertion change", async () => {
    delete process.env.TELNYX_API_KEY;
    const res = await POST(
      request({ businessId: BIZ, toE164: "+15550009999", associateWithPlatform: true })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/TELNYX_API_KEY/);
  });
});
