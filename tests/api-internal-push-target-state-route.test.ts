import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({ assertCronAuth: vi.fn() }));
vi.mock("@/lib/push/db", () => ({ pushTargetState: vi.fn() }));

import { POST } from "@/app/api/internal/push-target-state/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { pushTargetState } from "@/lib/push/db";

const BIZ = "11111111-1111-4111-8111-111111111111";

function post(body: unknown): Request {
  return new Request("https://app.test/api/internal/push-target-state", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertCronAuth).mockReturnValue(true);
  vi.mocked(pushTargetState).mockResolvedValue({ connected: true, deliverable: true });
});

describe("api/internal/push-target-state", () => {
  it("refuses without the cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    expect((await POST(post({ businessId: BIZ }))).status).toBe(403);
    expect(pushTargetState).not.toHaveBeenCalled();
  });

  it("returns the helper's flags so Deno does not re-derive them", async () => {
    const res = await POST(post({ businessId: BIZ }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { connected: true, deliverable: true }
    });
    expect(pushTargetState).toHaveBeenCalledWith(BIZ);
  });

  it("passes through a leaked-only verdict (connected, not deliverable)", async () => {
    vi.mocked(pushTargetState).mockResolvedValue({ connected: true, deliverable: false });
    const res = await POST(post({ businessId: BIZ }));
    expect(await res.json()).toEqual({
      ok: true,
      data: { connected: true, deliverable: false }
    });
  });

  it("rejects a non-uuid businessId", async () => {
    expect((await POST(post({ businessId: "nope" }))).status).toBe(400);
    expect(pushTargetState).not.toHaveBeenCalled();
  });

  it("rejects a null platform scope: this route is tenant-only", async () => {
    expect((await POST(post({ businessId: null }))).status).toBe(400);
    expect(pushTargetState).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected throw as a 500", async () => {
    vi.mocked(pushTargetState).mockRejectedValue(new Error("boom"));
    expect((await POST(post({ businessId: BIZ }))).status).toBe(500);
  });
});
