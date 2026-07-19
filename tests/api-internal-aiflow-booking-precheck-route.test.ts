import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({ assertCronAuth: vi.fn() }));
vi.mock("@/lib/ai-flows/booking-precheck", () => ({ bookingPrecheckForRun: vi.fn() }));

import { POST } from "@/app/api/internal/aiflow-booking-precheck/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { bookingPrecheckForRun } from "@/lib/ai-flows/booking-precheck";

const BIZ = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

function req(body: unknown) {
  return new Request("http://localhost/api/internal/aiflow-booking-precheck", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/internal/aiflow-booking-precheck route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertCronAuth).mockReturnValue(true);
  });

  it("403 without the cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await POST(req({ businessId: BIZ, runId: RUN }));
    expect(res.status).toBe(403);
    expect(bookingPrecheckForRun).not.toHaveBeenCalled();
  });

  it("400 on a malformed body (non-uuid ids)", async () => {
    const res = await POST(req({ businessId: "kyp", runId: RUN }));
    expect(res.status).toBe(400);
    expect(bookingPrecheckForRun).not.toHaveBeenCalled();
  });

  it("runs the check and returns its result", async () => {
    vi.mocked(bookingPrecheckForRun).mockResolvedValue({
      booked: true,
      jumpedRuns: 2,
      reason: "booked"
    });
    const res = await POST(req({ businessId: BIZ, runId: RUN }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ booked: true, jumpedRuns: 2, reason: "booked" });
    expect(bookingPrecheckForRun).toHaveBeenCalledWith(BIZ, RUN);
  });

  it("maps a thrown check failure to the standard error contract", async () => {
    vi.mocked(bookingPrecheckForRun).mockRejectedValue(new Error("db down"));
    const res = await POST(req({ businessId: BIZ, runId: RUN }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
