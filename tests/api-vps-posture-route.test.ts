import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({ rpc: rpcMock }))
}));

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyGatewayTokenForBusiness: vi.fn()
}));

vi.mock("@/lib/db/vps-posture", () => ({
  insertVpsPostureReport: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/vps/posture/route";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
import { insertVpsPostureReport } from "@/lib/db/vps-posture";
import { logger } from "@/lib/logger";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/vps/posture", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer per-tenant-token"
    },
    body: JSON.stringify(body)
  });
}

const passingChecks = [
  { name: "ufw_active", ok: true, detail: "ufw active" },
  { name: "ssh_password_auth_disabled", ok: true }
];

describe("api/vps/posture route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
    vi.mocked(insertVpsPostureReport).mockResolvedValue({
      id: "rep-1",
      business_id: BIZ_ID,
      ok: true,
      checks: [],
      created_at: "2026-07-08T00:00:00Z"
    });
    rpcMock.mockResolvedValue({ data: null, error: null });
  });

  it("persists a passing report without emitting telemetry", async () => {
    const res = await POST(makeRequest({ businessId: BIZ_ID, checks: passingChecks }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ received: true, ok: true });
    expect(insertVpsPostureReport).toHaveBeenCalledWith({
      businessId: BIZ_ID,
      ok: true,
      checks: passingChecks
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("drift persists ok=false, warns, and emits vps_posture_drift telemetry", async () => {
    const drift = [
      { name: "ufw_active", ok: false, detail: "ufw inactive" },
      { name: "fail2ban_active", ok: true }
    ];
    const res = await POST(makeRequest({ businessId: BIZ_ID, checks: drift }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "VPS posture drift reported",
      expect.objectContaining({ failed: ["ufw_active"] })
    );
    expect(rpcMock).toHaveBeenCalledWith("telemetry_record", {
      p_event_type: "vps_posture_drift",
      p_payload: expect.objectContaining({
        business_id: BIZ_ID,
        failed: [{ name: "ufw_active", detail: "ufw inactive" }]
      })
    });
  });

  it("a telemetry RPC failure never rejects the box's report", async () => {
    rpcMock.mockRejectedValue(new Error("rpc down"));
    const res = await POST(
      makeRequest({
        businessId: BIZ_ID,
        checks: [{ name: "ufw_active", ok: false }]
      })
    );
    expect(res.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      "vps_posture_drift telemetry emit failed",
      expect.objectContaining({ error: "rpc down" })
    );
  });

  it("401s on an unbound gateway token", async () => {
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(false);
    const res = await POST(makeRequest({ businessId: BIZ_ID, checks: passingChecks }));
    expect(res.status).toBe(401);
    expect(insertVpsPostureReport).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies (missing checks, empty array)", async () => {
    const missing = await POST(makeRequest({ businessId: BIZ_ID }));
    expect(missing.status).toBe(400);

    const empty = await POST(makeRequest({ businessId: BIZ_ID, checks: [] }));
    expect(empty.status).toBe(400);
    expect(insertVpsPostureReport).not.toHaveBeenCalled();
  });
});
