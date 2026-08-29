import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn().mockReturnValue(true),
  verifyGatewayTokenForBusiness: vi.fn().mockResolvedValue(true)
}));

vi.mock("@/lib/db/agent-tool-settings", () => ({
  isAgentToolEnabled: vi.fn()
}));

vi.mock("@/lib/sms/schedule-text", () => ({
  scheduleTextTool: vi.fn()
}));

import { POST } from "@/app/api/voice/tools/schedule-text/route";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import { scheduleTextTool } from "@/lib/sms/schedule-text";

const BIZ = "11111111-1111-4111-8111-111111111111";

function req(body: unknown) {
  return new Request("http://localhost/api/voice/tools/schedule-text", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer gw"
    },
    body: JSON.stringify(body)
  });
}

describe("POST /api/voice/tools/schedule-text", () => {
  const OLD = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD, ROWBOAT_GATEWAY_TOKEN: "gw" };
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
    vi.mocked(isAgentToolEnabled).mockResolvedValue(true);
    vi.mocked(scheduleTextTool).mockResolvedValue({
      ok: true,
      data: { sendAtLocal: "Aug 31, 6:30 PM EDT" },
      message: "Queued."
    });
  });

  afterEach(() => {
    process.env = OLD;
  });

  it("schedules to the caller ANI when phone is omitted", async () => {
    const res = await POST(
      req({
        businessId: BIZ,
        callerE164: "+15555550100",
        args: { sendAtIso: "2026-08-31T18:30:00-04:00", text: "Reminder: call at 6:30" }
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ sendAtLocal: "Aug 31, 6:30 PM EDT" });
    // The core's model-facing message must ride through the adapter.
    expect(body.message).toBe("Queued.");
    expect(scheduleTextTool).toHaveBeenCalledWith(BIZ, {
      phone: "+15555550100",
      action: "schedule",
      sendAtIso: "2026-08-31T18:30:00-04:00",
      text: "Reminder: call at 6:30",
      confirmed: undefined
    });
  });

  it("canonicalizes a dictated destination before the core runs", async () => {
    const res = await POST(
      req({
        businessId: BIZ,
        callerE164: "+15555550100",
        args: {
          phone: "(602) 555-0147",
          action: "schedule",
          sendAtIso: "2026-08-31T18:30:00-04:00",
          text: "hi",
          confirmed: true
        }
      })
    );
    expect(res.status).toBe(200);
    expect(scheduleTextTool).toHaveBeenCalledWith(BIZ, {
      phone: "+16025550147",
      action: "schedule",
      sendAtIso: "2026-08-31T18:30:00-04:00",
      text: "hi",
      confirmed: true
    });
  });

  it("passes cancel through with the action intact", async () => {
    vi.mocked(scheduleTextTool).mockResolvedValue({ ok: true, message: "Canceled." });
    const res = await POST(
      req({ businessId: BIZ, callerE164: "+15555550100", args: { action: "cancel" } })
    );
    expect(res.status).toBe(200);
    expect(scheduleTextTool).toHaveBeenCalledWith(BIZ, {
      phone: "+15555550100",
      action: "cancel",
      sendAtIso: undefined,
      text: undefined,
      confirmed: undefined
    });
  });

  it("refuses when there is no destination at all", async () => {
    const res = await POST(req({ businessId: BIZ, args: { text: "hi" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "no_destination" });
    expect(scheduleTextTool).not.toHaveBeenCalled();
  });

  it("refuses an unnormalizable destination rather than passing it on", async () => {
    const res = await POST(
      req({ businessId: BIZ, callerE164: "+15555550100", args: { phone: "not-a-number-at-all" } })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "invalid_destination" });
    expect(scheduleTextTool).not.toHaveBeenCalled();
  });

  it("refuses a non-NANP destination up front instead of queueing a text that dies at dispatch", async () => {
    const res = await POST(
      req({
        businessId: BIZ,
        callerE164: "+525512345678",
        args: { sendAtIso: "2026-08-31T18:30:00-04:00", text: "hola" }
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.detail).toBe("sms_unreachable_destination");
    expect(String(body.message)).toContain("US and Canada");
    expect(scheduleTextTool).not.toHaveBeenCalled();
  });

  it("400s on args that fail the schema", async () => {
    const res = await POST(
      req({ businessId: BIZ, callerE164: "+15555550100", args: { action: "postpone" } })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(String(body.detail)).toContain("invalid_args");
    expect(scheduleTextTool).not.toHaveBeenCalled();
  });

  it("400s on an invalid envelope", async () => {
    const res = await POST(req({ args: { text: "hi" } }));
    expect(res.status).toBe(400);
    expect(scheduleTextTool).not.toHaveBeenCalled();
  });

  it("400s on a body that is not JSON at all (the envelope parser degrades it to {})", async () => {
    const res = await POST(
      new Request("http://localhost/api/voice/tools/schedule-text", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer gw" },
        body: "not-json"
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(String(body.detail)).toContain("invalid_args");
    expect(scheduleTextTool).not.toHaveBeenCalled();
  });

  it("returns tool_disabled when the voice toggle is off", async () => {
    vi.mocked(isAgentToolEnabled).mockResolvedValue(false);
    const res = await POST(
      req({ businessId: BIZ, callerE164: "+15555550100", args: { text: "hi" } })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "tool_disabled" });
    expect(isAgentToolEnabled).toHaveBeenCalledWith(BIZ, "voice", "schedule_text");
    expect(scheduleTextTool).not.toHaveBeenCalled();
  });

  it("401s when the gateway token does not bind to the business", async () => {
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(false);
    const res = await POST(
      req({ businessId: BIZ, callerE164: "+15555550100", args: { text: "hi" } })
    );
    expect(res.status).toBe(401);
    expect(scheduleTextTool).not.toHaveBeenCalled();
  });
});
