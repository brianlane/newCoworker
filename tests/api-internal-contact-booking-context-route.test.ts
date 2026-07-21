import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({ assertCronAuth: vi.fn() }));
vi.mock("@/lib/ai-flows/contact-booking-context", () => ({
  contactBookingContextForPhone: vi.fn()
}));

import { POST } from "@/app/api/internal/contact-booking-context/route";
import { assertCronAuth } from "@/lib/cron-auth";
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
  });

  it("403 without the cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await POST(req({ businessId: BIZ, phone: PHONE }));
    expect(res.status).toBe(403);
    expect(contactBookingContextForPhone).not.toHaveBeenCalled();
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
    expect(contactBookingContextForPhone).toHaveBeenCalledWith(BIZ, PHONE, {}, undefined, null);
  });

  it("passes the caller's business timezone through so the line renders local (KYP/Ayanna)", async () => {
    vi.mocked(contactBookingContextForPhone).mockResolvedValue({ status: "none", line: null });
    const res = await POST(
      req({ businessId: BIZ, phone: PHONE, timezone: "America/Toronto" })
    );
    expect(res.status).toBe(200);
    expect(contactBookingContextForPhone).toHaveBeenCalledWith(
      BIZ,
      PHONE,
      {},
      undefined,
      "America/Toronto"
    );
  });

  it("maps a thrown lookup failure to the standard error contract", async () => {
    vi.mocked(contactBookingContextForPhone).mockRejectedValue(new Error("db down"));
    const res = await POST(req({ businessId: BIZ, phone: PHONE }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
