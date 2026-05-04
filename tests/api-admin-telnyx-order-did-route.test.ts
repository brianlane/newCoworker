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
  orderAndAssignDidForBusiness: vi.fn(),
  OrderAndAssignError: class OrderAndAssignError extends Error {
    public readonly reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.reason = reason;
      this.name = "OrderAndAssignError";
    }
  },
  normalizeE164: (n: string) => {
    const digits = n.replace(/[^\d+]/g, "");
    if (!digits.startsWith("+")) throw new Error("normalizeE164: invalid");
    return digits;
  }
}));

import { POST } from "@/app/api/admin/telnyx/order-did/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { orderAndAssignDidForBusiness } from "@/lib/telnyx/assign-did";

const BIZ = "11111111-1111-4111-8111-111111111111";

function request(body: unknown): Request {
  return new Request("http://test/api/admin/telnyx/order-did", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

const ORIGINAL_ENV = process.env;

describe("POST /api/admin/telnyx/order-did — platform-defaults assertion guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      TELNYX_API_KEY: "key",
      TELNYX_CONNECTION_ID: "mock_conn",
      TELNYX_MESSAGING_PROFILE_ID: "mock_prof"
    };
    vi.mocked(requireAdmin).mockResolvedValue({} as never);
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Corp"
    } as never);
    vi.mocked(orderAndAssignDidForBusiness).mockResolvedValue({
      route: { to_e164: "+15550009999" },
      settings: {},
      orderId: "order-1"
    } as never);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("places the order when both connectionId and messagingProfileId are configured (happy path)", async () => {
    const res = await POST(request({ businessId: BIZ, areaCode: "602" }));
    expect(res.status).toBe(200);
    expect(orderAndAssignDidForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        platformDefaults: expect.objectContaining({
          connectionId: "mock_conn",
          messagingProfileId: "mock_prof"
        })
      }),
      expect.any(Object)
    );
  });

  it("returns 400 VALIDATION_ERROR when TELNYX_CONNECTION_ID is missing — admin clicked 'Buy' before the env was deployed", async () => {
    delete process.env.TELNYX_CONNECTION_ID;
    const res = await POST(request({ businessId: BIZ, areaCode: "602" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toMatch(/connectionId/);
    expect(body.error.message).toMatch(/Refusing to provision/);
    // Critical: we did NOT spend money on a number that wouldn't carry calls.
    expect(orderAndAssignDidForBusiness).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR when TELNYX_MESSAGING_PROFILE_ID is missing — SMS would be unwired", async () => {
    delete process.env.TELNYX_MESSAGING_PROFILE_ID;
    const res = await POST(request({ businessId: BIZ, areaCode: "602" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/messagingProfileId/);
    expect(orderAndAssignDidForBusiness).not.toHaveBeenCalled();
  });

  it("still returns 400 (not 200) when Telnyx returns an OrderAndAssignError — the error path is mapped to CONFLICT", async () => {
    const { OrderAndAssignError } = await import("@/lib/telnyx/assign-did");
    vi.mocked(orderAndAssignDidForBusiness).mockRejectedValueOnce(
      new OrderAndAssignError("no_numbers_available", "no numbers")
    );
    const res = await POST(request({ businessId: BIZ, areaCode: "602" }));
    expect(res.status).toBe(409);
  });

  it("returns 404 when business is not found — guard runs before assertion", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce(null);
    const res = await POST(request({ businessId: BIZ }));
    expect(res.status).toBe(404);
    expect(orderAndAssignDidForBusiness).not.toHaveBeenCalled();
  });

  it("returns 400 when TELNYX_API_KEY is missing — runs before assertion since it's the more obvious config gap", async () => {
    delete process.env.TELNYX_API_KEY;
    const res = await POST(request({ businessId: BIZ }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/TELNYX_API_KEY/);
  });
});
