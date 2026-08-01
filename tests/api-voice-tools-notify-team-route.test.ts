import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn().mockReturnValue(true),
  verifyGatewayTokenForBusiness: vi.fn().mockResolvedValue(true)
}));

vi.mock("@/lib/db/agent-tool-settings", () => ({
  isAgentToolEnabled: vi.fn()
}));

vi.mock("@/lib/db/logs", () => ({
  insertCoworkerLog: vi.fn()
}));

vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: vi.fn()
}));

vi.mock("@/lib/notifications/dispatch", () => ({
  dispatchUrgentNotification: vi.fn()
}));

import { POST } from "@/app/api/voice/tools/notify-team/route";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import { insertCoworkerLog } from "@/lib/db/logs";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";

const BIZ = "11111111-1111-4111-8111-111111111111";

function req(body: unknown) {
  return new Request("http://localhost/api/voice/tools/notify-team", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer gw"
    },
    body: JSON.stringify(body)
  });
}

describe("POST /api/voice/tools/notify-team", () => {
  const OLD = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD, ROWBOAT_GATEWAY_TOKEN: "gw" };
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
    vi.mocked(isAgentToolEnabled).mockResolvedValue(true);
    vi.mocked(dispatchUrgentNotification).mockResolvedValue({
      results: [
        { channel: "dashboard", status: "sent", notificationId: "n1" },
        { channel: "sms", status: "sent", notificationId: "n2" }
      ]
    });
  });

  afterEach(() => {
    process.env = OLD;
  });

  it("401s without a gateway token", async () => {
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValueOnce(false);
    const res = await POST(req({ businessId: BIZ, args: { message: "call back" } }));
    expect(res.status).toBe(401);
  });

  it("returns tool_disabled when the owner turned the tool off", async () => {
    vi.mocked(isAgentToolEnabled).mockResolvedValue(false);
    const res = await POST(req({ businessId: BIZ, args: { message: "call back" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "tool_disabled" });
    expect(vi.mocked(isAgentToolEnabled)).toHaveBeenCalledWith(BIZ, "voice", "notify_team");
    expect(insertCoworkerLog).not.toHaveBeenCalled();
  });

  it("rejects an empty message", async () => {
    const res = await POST(req({ businessId: BIZ, args: {} }));
    expect(res.status).toBe(400);
  });

  it("logs to coworker_logs and dispatches to the owner", async () => {
    const res = await POST(
      req({
        businessId: BIZ,
        callControlId: "cc_1",
        callerE164: "+15555550100",
        args: { message: "Confirm the Maple St showing tomorrow at 2pm", callerName: "Brian" }
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.notified).toBe(true);
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ,
        task_type: "call",
        status: "urgent_alert",
        log_payload: expect.objectContaining({
          source: "voice_tool_notify_team",
          callerName: "Brian",
          callerPhone: "+15555550100",
          message: "Confirm the Maple St showing tomorrow at 2pm"
        })
      })
    );
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        kind: "voice_team_notify",
        // The alert is about this caller, so it routes to whichever teammate
        // owns them rather than always to the business owner.
        contactE164: "+15555550100",
        summary: expect.stringContaining("Maple St"),
        smsBody: expect.stringContaining("Brian (+15555550100)")
      })
    );
  });

  it("normalizes a model-formatted callerPhone before storing and routing", async () => {
    // Same rationale as the sms twin (Bugbot, PR #1115): dedupe and routing
    // compare this against worker-normalized E.164 values.
    const res = await POST(
      req({ businessId: BIZ, args: { message: "call back", callerPhone: "480.555.0100" } })
    );
    expect(res.status).toBe(200);
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({
        log_payload: expect.objectContaining({ callerPhone: "+14805550100" })
      })
    );
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({ contactE164: "+14805550100" })
    );
  });

  it("truncates the summary at a word boundary and keeps the full request in the SMS body", async () => {
    const message =
      "Caller wants a quote for a five bedroom rental near Roosevelt Row with a garage, " +
      "a pool, updated appliances, and availability for a walkthrough on the weekend, " +
      "and asked that whoever calls back mention the promotional rate they saw online.";
    const res = await POST(req({ businessId: BIZ, callerE164: "+15555550100", args: { message } }));
    expect(res.status).toBe(200);
    const input = vi.mocked(dispatchUrgentNotification).mock.calls.at(-1)?.[0] as {
      summary: string;
      smsBody?: string;
    };
    const full = `Caller follow-up needed: ${message}`;
    expect(input.summary.length).toBeLessThanOrEqual(200);
    expect(input.summary.endsWith("…")).toBe(true);
    const kept = input.summary.slice(0, -1);
    expect(full.startsWith(kept)).toBe(true);
    expect(/\s/.test(full.charAt(kept.length))).toBe(true);
    expect(input.smsBody).toContain("promotional rate they saw online.");
  });

  it("still returns ok with notified=false when dispatch fails (log row is the fallback)", async () => {
    vi.mocked(dispatchUrgentNotification).mockRejectedValueOnce(new Error("down"));
    const res = await POST(req({ businessId: BIZ, args: { message: "call back" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.notified).toBe(false);
    expect(insertCoworkerLog).toHaveBeenCalled();
  });

  it("notified=false when every channel was skipped", async () => {
    vi.mocked(dispatchUrgentNotification).mockResolvedValueOnce({
      results: [
        { channel: "dashboard", status: "skipped", reason: "dashboard_alerts_disabled", notificationId: "n1" },
        { channel: "email", status: "skipped", reason: "no_email", notificationId: "n2" },
        { channel: "sms", status: "skipped", reason: "no_phone", notificationId: "n3" }
      ]
    });
    const res = await POST(req({ businessId: BIZ, args: { message: "call back" } }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.notified).toBe(false);
  });

  it("fails closed with internal_error when the log write throws", async () => {
    vi.mocked(insertCoworkerLog).mockRejectedValueOnce(new Error("db down"));
    const res = await POST(req({ businessId: BIZ, args: { message: "call back" } }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ ok: false, detail: "internal_error" });
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });
});
