import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/configs", () => ({
  getBusinessConfig: vi.fn(),
  patchBusinessConfig: vi.fn()
}));

vi.mock("@/lib/vps/sync-vault", () => ({
  syncVaultToVpsAndLog: vi.fn()
}));

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn().mockReturnValue(true)
}));

import { POST } from "@/app/api/voice/tools/owner-append-business-memory/route";
import { getBusinessConfig, patchBusinessConfig } from "@/lib/db/configs";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";
import { verifyRowboatGatewayToken } from "@/lib/rowboat/gateway-token";

const BIZ = "11111111-1111-4111-8111-111111111111";

function makeReq(body: unknown, token = "gw"): Request {
  return new Request("http://localhost/api/voice/tools/owner-append-business-memory", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyRowboatGatewayToken).mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/voice/tools/owner-append-business-memory", () => {
  it("401s without gateway bearer", async () => {
    vi.mocked(verifyRowboatGatewayToken).mockReturnValue(false);
    const res = await POST(
      makeReq({
        businessId: BIZ,
        args: { bullets: "Never ask for budget." }
      })
    );
    expect(res.status).toBe(401);
  });

  it("rejects when callerE164 is present (customer channels)", async () => {
    const res = await POST(
      makeReq({
        businessId: BIZ,
        callerE164: "+15551234567",
        args: { bullets: "Never ask for budget." }
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "owner_dashboard_only" });
    expect(patchBusinessConfig).not.toHaveBeenCalled();
  });

  it("appends bullets to memory_md and triggers vault sync", async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue({
      business_id: BIZ,
      soul_md: "",
      identity_md: "",
      memory_md: "Prior line",
      website_md: "",
      updated_at: ""
    });

    const res = await POST(
      makeReq({
        businessId: BIZ,
        args: { bullets: "Never discuss budget.\nAlways mention brokerage name." }
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.appended).toBe(true);
    expect(json.data.bulletCount).toBe(2);

    expect(patchBusinessConfig).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        memory_md: expect.stringContaining("Prior line")
      })
    );
    const written = vi.mocked(patchBusinessConfig).mock.calls[0][1].memory_md as string;
    expect(written).toMatch(/### Owner chat \(\d{4}-\d{2}-\d{2}\)/);
    expect(written).toContain("- Never discuss budget.");
    expect(written).toContain("- Always mention brokerage name.");
    expect(syncVaultToVpsAndLog).toHaveBeenCalledWith(BIZ);
  });

  it("400 when bullets empty after trim", async () => {
    const res = await POST(
      makeReq({
        businessId: BIZ,
        args: { bullets: "   \n  \t  " }
      })
    );
    expect(res.status).toBe(400);
  });
});
