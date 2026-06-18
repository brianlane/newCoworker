import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn().mockReturnValue(true),
  verifyGatewayTokenForBusiness: vi.fn().mockResolvedValue(true)
}));

vi.mock("@/lib/db/logs", () => ({
  insertCoworkerLog: vi.fn()
}));

vi.mock("@/lib/notifications/dispatch", () => ({
  dispatchUrgentNotification: vi.fn()
}));

vi.mock("@/lib/db/agent-tool-settings", () => ({
  isAgentToolEnabled: vi.fn()
}));

import { POST } from "@/app/api/voice/tools/capture/route";
import { verifyRowboatGatewayToken } from "@/lib/rowboat/gateway-token";
import { insertCoworkerLog } from "@/lib/db/logs";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";

const BIZ = "11111111-1111-4111-8111-111111111111";

function req(body: unknown) {
  return new Request("http://localhost/api/voice/tools/capture", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: "Bearer gw"
    },
    body: JSON.stringify(body)
  });
}

describe("api/voice/tools/capture route", () => {
  const original = process.env;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...original, ROWBOAT_GATEWAY_TOKEN: "gw" };
    vi.mocked(verifyRowboatGatewayToken).mockReturnValue(true);
    vi.mocked(isAgentToolEnabled).mockResolvedValue(true);
  });
  afterEach(() => {
    process.env = original;
  });

  it("401s without gateway token", async () => {
    vi.mocked(verifyRowboatGatewayToken).mockReturnValue(false);
    const r = await POST(req({ businessId: BIZ, args: { name: "Alex" } }));
    expect(r.status).toBe(401);
  });

  it("returns tool_disabled when the owner turned the tool off (Settings → Coworker tools)", async () => {
    vi.mocked(isAgentToolEnabled).mockResolvedValue(false);
    const r = await POST(req({ businessId: BIZ, args: { name: "Alex" } }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: false, detail: "tool_disabled" });
    expect(vi.mocked(isAgentToolEnabled)).toHaveBeenCalledWith(
      BIZ,
      "voice",
      "capture_caller_details"
    );
    expect(insertCoworkerLog).not.toHaveBeenCalled();
  });

  it("logs but does not dispatch for non-urgent capture", async () => {
    const r = await POST(req({ businessId: BIZ, args: { name: "Alex", reason: "callback" } }));
    expect(r.status).toBe(200);
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({ business_id: BIZ, status: "success" })
    );
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });

  it("dispatches urgent notification when urgency==='high'", async () => {
    const r = await POST(
      req({
        businessId: BIZ,
        args: { name: "Alex", reason: "burst pipe", urgency: "high" }
      })
    );
    expect(r.status).toBe(200);
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: "urgent_alert" })
    );
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        kind: "voice_capture",
        summary: expect.stringContaining("burst pipe")
      })
    );
  });

  it("still returns success when dispatch throws (caller is mid-call)", async () => {
    vi.mocked(dispatchUrgentNotification).mockRejectedValueOnce(new Error("down"));
    const r = await POST(
      req({
        businessId: BIZ,
        args: { name: "Alex", urgency: "high", reason: "fire" }
      })
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
  });

  it("rejects empty captures", async () => {
    const r = await POST(req({ businessId: BIZ, args: {} }));
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.detail).toBe("empty_capture");
    expect(insertCoworkerLog).not.toHaveBeenCalled();
  });
});
