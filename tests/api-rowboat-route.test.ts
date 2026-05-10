import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn().mockReturnValue(true)
}));
vi.mock("@/lib/db/logs", () => ({ insertCoworkerLog: vi.fn() }));
vi.mock("@/lib/notifications/dispatch", () => ({
  dispatchUrgentNotification: vi.fn()
}));

import { POST } from "@/app/api/rowboat/route";
import { verifyRowboatGatewayToken } from "@/lib/rowboat/gateway-token";
import { insertCoworkerLog } from "@/lib/db/logs";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";

const BIZ = "11111111-1111-4111-8111-111111111111";

function payload(status: string) {
  return {
    businessId: BIZ,
    taskType: "call",
    status,
    logPayload: { foo: "bar" },
    createdAt: "2026-01-01T00:00:00Z"
  };
}

function makeReq(body: unknown) {
  return new Request("http://localhost/api/rowboat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/rowboat route", () => {
  const original = process.env;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyRowboatGatewayToken).mockReturnValue(true);
    process.env = { ...original };
  });
  afterEach(() => {
    process.env = original;
  });

  it("rejects unauthorized requests", async () => {
    vi.mocked(verifyRowboatGatewayToken).mockReturnValue(false);
    const res = await POST(makeReq(payload("urgent_alert")));
    expect(res.status).toBe(401);
    expect(insertCoworkerLog).not.toHaveBeenCalled();
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });

  it("writes a log without dispatching for non-urgent statuses", async () => {
    const res = await POST(makeReq(payload("success")));
    expect(res.status).toBe(200);
    expect(insertCoworkerLog).toHaveBeenCalledTimes(1);
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });

  it("dispatches the urgent notification on urgent_alert", async () => {
    const res = await POST(makeReq(payload("urgent_alert")));
    expect(res.status).toBe(200);
    expect(insertCoworkerLog).toHaveBeenCalledTimes(1);
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        kind: "urgent_alert",
        summary: expect.stringContaining("URGENT")
      })
    );
  });

  it("returns 200 even if the dispatcher throws (alert is best-effort)", async () => {
    vi.mocked(dispatchUrgentNotification).mockRejectedValueOnce(new Error("boom"));
    const res = await POST(makeReq(payload("urgent_alert")));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 400 on malformed payload", async () => {
    const res = await POST(makeReq({ wrong: true }));
    expect(res.status).toBe(400);
  });
});
