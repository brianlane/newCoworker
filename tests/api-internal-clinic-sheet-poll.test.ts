import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({ assertCronAuth: vi.fn() }));
vi.mock("@/lib/clinic-sheets/poll", () => ({ pollClinicSheets: vi.fn() }));

import { POST } from "@/app/api/internal/clinic-sheet-poll/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { pollClinicSheets } from "@/lib/clinic-sheets/poll";

function req() {
  return new Request("http://localhost/api/internal/clinic-sheet-poll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
}

describe("api/internal/clinic-sheet-poll route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertCronAuth).mockReturnValue(true);
  });

  it("403 without the cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(pollClinicSheets).not.toHaveBeenCalled();
  });

  it("runs one poll and returns its counts", async () => {
    vi.mocked(pollClinicSheets).mockResolvedValue({
      configured: true,
      sheets: 3,
      baselined: 0,
      enqueued: 1,
      failed: 0
    });
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.enqueued).toBe(1);
  });

  it("maps a thrown poll failure to the standard error contract", async () => {
    vi.mocked(pollClinicSheets).mockRejectedValue(new Error("db down"));
    const res = await POST(req());
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
