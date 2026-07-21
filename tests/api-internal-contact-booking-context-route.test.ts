import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({ assertCronAuth: vi.fn() }));
vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyGatewayTokenForBusiness: vi.fn()
}));
vi.mock("@/lib/ai-flows/contact-booking-context", () => ({
  contactBookingContextForPhone: vi.fn()
}));

import { POST } from "@/app/api/internal/contact-booking-context/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
import { contactBookingContextForPhone } from "@/lib/ai-flows/contact-booking-context";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PHONE = "+17808039935";

function req(body: unknown) {
  return new Request("http://localhost/api/internal/contact-booking-context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/internal/contact-booking-context route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertCronAuth).mockReturnValue(true);
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(false);
  });

  it("403 when NEITHER the cron bearer nor a tenant-bound gateway token authorizes", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(false);
    const res = await POST(req({ businessId: BIZ, phone: PHONE }));
    expect(res.status).toBe(403);
    expect(contactBookingContextForPhone).not.toHaveBeenCalled();
  });

  it("accepts a per-tenant gateway bearer bound to the businessId (voice-bridge caller)", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
    vi.mocked(contactBookingContextForPhone).mockResolvedValue({
      status: "booked",
      line: "This contact has an upcoming booking."
    });
    const res = await POST(req({ businessId: BIZ, phone: PHONE }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("booked");
    expect(verifyGatewayTokenForBusiness).toHaveBeenCalledWith(expect.anything(), BIZ);
  });

  it("400 on a malformed body (non-uuid business, too-short phone)", async () => {
    expect((await POST(req({ businessId: "kyp", phone: PHONE }))).status).toBe(400);
    expect((await POST(req({ businessId: BIZ, phone: "+1" }))).status).toBe(400);
    expect(contactBookingContextForPhone).not.toHaveBeenCalled();
  });

  it("runs the lookup and returns its result", async () => {
    vi.mocked(contactBookingContextForPhone).mockResolvedValue({
      status: "rescheduled",
      line: "This contact has an upcoming booking…"
    });
    const res = await POST(req({ businessId: BIZ, phone: ` ${PHONE} ` }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      status: "rescheduled",
      line: "This contact has an upcoming booking…"
    });
    expect(contactBookingContextForPhone).toHaveBeenCalledWith(BIZ, PHONE);
  });

  it("maps a thrown lookup failure to the standard error contract", async () => {
    vi.mocked(contactBookingContextForPhone).mockRejectedValue(new Error("db down"));
    const res = await POST(req({ businessId: BIZ, phone: PHONE }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
