import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/db/admin-mutes", () => ({
  setAdminNotificationMutes: vi.fn()
}));

import { POST } from "@/app/api/admin/notification-mutes/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { setAdminNotificationMutes } from "@/lib/db/admin-mutes";

const BIZ = "22222222-2222-4222-8222-222222222222";

function request(body: unknown): Request {
  return new Request("http://test/api/admin/notification-mutes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/admin/notification-mutes", () => {
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
    vi.mocked(setAdminNotificationMutes).mockResolvedValue({
      muteActivity: true,
      muteErrors: false,
      muteAlerts: true
    });
  });

  it("patches the provided switches and returns the effective state", async () => {
    const res = await POST(request({ businessId: BIZ, muteActivity: true, muteAlerts: true }));
    expect(res.status).toBe(200);
    expect(setAdminNotificationMutes).toHaveBeenCalledWith(BIZ, {
      muteActivity: true,
      muteErrors: undefined,
      muteAlerts: true
    });
    const json = (await res.json()) as {
      ok: boolean;
      data?: { mutes: { muteActivity: boolean } };
    };
    expect(json.ok).toBe(true);
    expect(json.data?.mutes.muteActivity).toBe(true);
  });

  it("rejects a body with no switches", async () => {
    const res = await POST(request({ businessId: BIZ }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error?: { code: string } };
    expect(json.error?.code).toBe("VALIDATION_ERROR");
    expect(setAdminNotificationMutes).not.toHaveBeenCalled();
  });

  it("rejects a malformed businessId", async () => {
    const res = await POST(request({ businessId: "nope", muteErrors: true }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce(null);
    const res = await POST(request({ businessId: BIZ, muteErrors: true }));
    expect(res.status).toBe(404);
    expect(setAdminNotificationMutes).not.toHaveBeenCalled();
  });

  it("propagates admin auth failures", async () => {
    const err = Object.assign(new Error("forbidden"), { status: 403 });
    vi.mocked(requireAdmin).mockRejectedValueOnce(err);
    const res = await POST(request({ businessId: BIZ, muteErrors: true }));
    expect(res.status).toBe(403);
  });
});
