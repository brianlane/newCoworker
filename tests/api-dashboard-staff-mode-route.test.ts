import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/owner-surfaces/staff-mode", () => ({ setStaffMode: vi.fn() }));

import { PUT } from "@/app/api/dashboard/staff-mode/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { setStaffMode } from "@/lib/owner-surfaces/staff-mode";
import { OWNER_SURFACES } from "@/lib/owner-surfaces/registry";

const BIZ = "11111111-1111-4111-8111-111111111111";

function putRequest(body: unknown): Request {
  return new Request("http://localhost/api/dashboard/staff-mode", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@x.co", isAdmin: false } as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
  vi.mocked(setStaffMode).mockImplementation(async (_b, _s, enabled) => enabled);
});

describe("PUT /api/dashboard/staff-mode", () => {
  it("requires authentication", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const res = await PUT(putRequest({ businessId: BIZ, surfaceKey: "whatsapp", enabled: true }));
    expect(res.status).toBe(401);
    expect(setStaffMode).not.toHaveBeenCalled();
  });

  it("requires manage_settings on the business", async () => {
    vi.mocked(requireBusinessRole).mockRejectedValue(new Error("forbidden"));
    const res = await PUT(putRequest({ businessId: BIZ, surfaceKey: "whatsapp", enabled: true }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(setStaffMode).not.toHaveBeenCalled();
  });

  it("stores the flag and echoes what was stored", async () => {
    const res = await PUT(putRequest({ businessId: BIZ, surfaceKey: "whatsapp", enabled: false }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: { surfaceKey: "whatsapp", enabled: false }
    });
    expect(setStaffMode).toHaveBeenCalledWith(BIZ, "whatsapp", false);
  });

  it("echoes the STORED value, not the requested one", async () => {
    // The dashboard switch renders whatever comes back, so a write that
    // resolved differently must not be reported as the click.
    vi.mocked(setStaffMode).mockResolvedValue(true);
    const res = await PUT(putRequest({ businessId: BIZ, surfaceKey: "sms", enabled: false }));
    await expect(res.json()).resolves.toMatchObject({ data: { enabled: true } });
  });

  it("accepts every registered surface, so a new one needs no route change", async () => {
    for (const surface of OWNER_SURFACES) {
      const res = await PUT(
        putRequest({ businessId: BIZ, surfaceKey: surface.key, enabled: true })
      );
      expect(res.status, surface.key).toBe(200);
    }
  });

  it("rejects a surface the registry does not know", async () => {
    const res = await PUT(
      putRequest({ businessId: BIZ, surfaceKey: "carrier-pigeon", enabled: true })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(setStaffMode).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    const res = await PUT(putRequest({ businessId: "not-a-uuid", surfaceKey: "sms" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(setStaffMode).not.toHaveBeenCalled();
  });

  it("lets an admin through without a per-business role check", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "ops@x.co", isAdmin: true } as never);
    const res = await PUT(putRequest({ businessId: BIZ, surfaceKey: "slack", enabled: true }));
    expect(res.status).toBe(200);
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });
});
