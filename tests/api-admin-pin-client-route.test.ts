import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  setBusinessAdminPinned: vi.fn()
}));

import { POST } from "@/app/api/admin/pin-client/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness, setBusinessAdminPinned } from "@/lib/db/businesses";

const BIZ = "22222222-2222-4222-8222-222222222222";

function request(body: unknown): Request {
  return new Request("http://test/api/admin/pin-client", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/admin/pin-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "a",
      email: "a@a.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Corp",
      owner_email: "o@o.com",
      tier: "starter",
      status: "online",
      created_at: "2026-01-01T00:00:00Z"
    } as never);
    vi.mocked(setBusinessAdminPinned).mockResolvedValue(undefined);
  });

  it("pins and unpins a business, echoing the new state", async () => {
    const pin = await POST(request({ businessId: BIZ, pinned: true }));
    expect(pin.status).toBe(200);
    expect(setBusinessAdminPinned).toHaveBeenCalledWith(BIZ, true);
    const pinJson = (await pin.json()) as { ok: boolean; data?: { pinned: boolean } };
    expect(pinJson.ok).toBe(true);
    expect(pinJson.data?.pinned).toBe(true);

    const unpin = await POST(request({ businessId: BIZ, pinned: false }));
    expect(unpin.status).toBe(200);
    expect(setBusinessAdminPinned).toHaveBeenLastCalledWith(BIZ, false);
  });

  it("rejects a malformed businessId and a missing pinned flag", async () => {
    expect((await POST(request({ businessId: "nope", pinned: true }))).status).toBe(400);
    expect((await POST(request({ businessId: BIZ }))).status).toBe(400);
    expect(setBusinessAdminPinned).not.toHaveBeenCalled();
  });

  it("returns 404 when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce(null);
    const res = await POST(request({ businessId: BIZ, pinned: true }));
    expect(res.status).toBe(404);
    expect(setBusinessAdminPinned).not.toHaveBeenCalled();
  });

  it("propagates admin auth failures", async () => {
    const err = Object.assign(new Error("forbidden"), { status: 403 });
    vi.mocked(requireAdmin).mockRejectedValueOnce(err);
    const res = await POST(request({ businessId: BIZ, pinned: true }));
    expect(res.status).toBe(403);
  });
});
