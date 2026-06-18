import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn().mockReturnValue(true),
  verifyGatewayTokenForBusiness: vi.fn().mockResolvedValue(true)
}));

vi.mock("@/lib/email/owner-mailbox", () => ({
  sendFromOwnerMailbox: vi.fn()
}));

vi.mock("@/lib/db/agent-tool-settings", () => ({
  isAgentToolEnabled: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock("@/lib/db/email-log", () => ({
  recordOutboundAssistantEmail: vi.fn()
}));

import { POST } from "@/app/api/voice/tools/dashboard-email/route";
import { verifyRowboatGatewayToken } from "@/lib/rowboat/gateway-token";
import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import { recordOutboundAssistantEmail } from "@/lib/db/email-log";

const businessId = "11111111-1111-4111-8111-111111111111";
const validArgs = { toEmail: "lead@example.com", subject: "Hello", bodyText: "Hi" };

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/voice/tools/dashboard-email", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer gw" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyRowboatGatewayToken).mockReturnValue(true);
  vi.mocked(isAgentToolEnabled).mockResolvedValue(true);
  vi.mocked(sendFromOwnerMailbox).mockResolvedValue({
    ok: true,
    provider: "microsoft",
    messageId: null
  });
});

describe("POST /api/voice/tools/dashboard-email", () => {
  it("rejects requests without a gateway token", async () => {
    vi.mocked(verifyRowboatGatewayToken).mockReturnValue(false);
    const res = await POST(makeRequest({ businessId, args: validArgs }));
    expect(res.status).toBe(401);
  });

  it("refuses caller-attributed envelopes — owner dashboard only", async () => {
    const res = await POST(
      makeRequest({ businessId, callerE164: "+15555550123", args: validArgs })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "owner_dashboard_only" });
    expect(sendFromOwnerMailbox).not.toHaveBeenCalled();
  });

  it("rejects malformed args", async () => {
    const res = await POST(
      makeRequest({ businessId, args: { ...validArgs, toEmail: "not-an-email" } })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toMatch(/^invalid_args:/);
  });

  it("returns tool_disabled when the owner has not enabled dashboard send_email", async () => {
    vi.mocked(isAgentToolEnabled).mockResolvedValue(false);
    const res = await POST(makeRequest({ businessId, args: validArgs }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "tool_disabled" });
    expect(vi.mocked(isAgentToolEnabled)).toHaveBeenCalledWith(businessId, "dashboard", "send_email");
    expect(sendFromOwnerMailbox).not.toHaveBeenCalled();
  });

  it("sends via the owner mailbox when enabled", async () => {
    const res = await POST(makeRequest({ businessId, args: validArgs }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { messageId: null, provider: "microsoft" }
    });
    expect(vi.mocked(sendFromOwnerMailbox)).toHaveBeenCalledWith(businessId, {
      toEmail: "lead@example.com",
      subject: "Hello",
      bodyText: "Hi",
      ccEmails: [],
      bccEmails: []
    });
    expect(vi.mocked(recordOutboundAssistantEmail)).toHaveBeenCalledWith({
      businessId,
      toEmail: "lead@example.com",
      subject: "Hello",
      bodyText: "Hi",
      source: "dashboard_chat",
      providerMessageId: null,
      ccEmails: [],
      bccEmails: []
    });
  });

  it("forwards email_not_connected from the mailbox layer", async () => {
    vi.mocked(sendFromOwnerMailbox).mockResolvedValue({ ok: false, detail: "email_not_connected" });
    const res = await POST(makeRequest({ businessId, args: validArgs }));
    expect(await res.json()).toEqual({ ok: false, detail: "email_not_connected" });
    expect(vi.mocked(recordOutboundAssistantEmail)).not.toHaveBeenCalled();
  });

  it("returns email_send_failed (500) on provider errors", async () => {
    vi.mocked(sendFromOwnerMailbox).mockRejectedValue(new Error("graph 500"));
    const res = await POST(makeRequest({ businessId, args: validArgs }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, detail: "email_send_failed" });
  });
});
