import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn().mockReturnValue(true),
  verifyGatewayTokenForBusiness: vi.fn().mockResolvedValue(true)
}));

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  getWorkspaceOAuthConnection: vi.fn()
}));

vi.mock("@/lib/email/owner-mailbox", () => ({
  sendFromMailboxConnection: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: vi.fn().mockResolvedValue(undefined)
}));

import { POST } from "@/app/api/aiflows/send-owner-email/route";
import { verifyRowboatGatewayToken } from "@/lib/rowboat/gateway-token";
import { getWorkspaceOAuthConnection } from "@/lib/db/workspace-oauth-connections";
import { sendFromMailboxConnection } from "@/lib/email/owner-mailbox";
import { recordSystemLog } from "@/lib/db/system-logs";

const businessId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const validBody = {
  businessId,
  connectionId,
  toEmail: "lead@example.com",
  subject: "Following up",
  bodyText: "Hi — still interested?"
};

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/aiflows/send-owner-email", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer gw" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

function connRow(provider_config_key: string) {
  return { id: connectionId, provider_config_key, connection_id: "cx-1" } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyRowboatGatewayToken).mockReturnValue(true);
  vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(connRow("google-mail"));
  vi.mocked(sendFromMailboxConnection).mockResolvedValue({
    ok: true,
    provider: "google",
    messageId: "gmail-1"
  });
});

describe("POST /api/aiflows/send-owner-email", () => {
  it("rejects requests without a gateway token", async () => {
    vi.mocked(verifyRowboatGatewayToken).mockReturnValue(false);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(401);
    expect(sendFromMailboxConnection).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies (zod issue + non-JSON)", async () => {
    const bad = await POST(makeRequest({ ...validBody, toEmail: "nope" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).detail).toMatch(/^invalid_args:/);

    const nonJson = await POST(makeRequest("not json"));
    expect(nonJson.status).toBe(400);
  });

  it("returns connection_not_found when the id doesn't belong to the business", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(null);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "connection_not_found" });
    expect(sendFromMailboxConnection).not.toHaveBeenCalled();
  });

  it("returns not_email_connection for a non-mailbox connection", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(connRow("google-calendar"));
    const res = await POST(makeRequest(validBody));
    expect(await res.json()).toEqual({ ok: false, detail: "not_email_connection" });
  });

  it("sends through the resolved connection and returns the provider id", async () => {
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { messageId: "gmail-1", provider: "google" }
    });
    expect(sendFromMailboxConnection).toHaveBeenCalledWith(
      businessId,
      { provider: "google", providerConfigKey: "google-mail", connectionId: "cx-1" },
      {
        toEmail: "lead@example.com",
        subject: "Following up",
        bodyText: "Hi — still interested?",
        ccEmails: [],
        bccEmails: []
      }
    );
  });

  it("maps an outlook key to the microsoft provider", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(connRow("outlook"));
    vi.mocked(sendFromMailboxConnection).mockResolvedValue({
      ok: true,
      provider: "microsoft",
      messageId: null
    });
    const res = await POST(makeRequest(validBody));
    expect(await res.json()).toEqual({
      ok: true,
      data: { messageId: null, provider: "microsoft" }
    });
    expect(vi.mocked(sendFromMailboxConnection).mock.calls[0][1].provider).toBe("microsoft");
  });

  it("passes through an ok:false detail from the sender", async () => {
    vi.mocked(sendFromMailboxConnection).mockResolvedValue({
      ok: false,
      detail: "email_not_connected"
    });
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "email_not_connected" });
  });

  it("returns 500 email_send_failed and logs when the provider throws", async () => {
    vi.mocked(sendFromMailboxConnection).mockRejectedValue(new Error("gmail 500"));
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, detail: "email_send_failed" });
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_owner_email_failed", level: "error" })
    );
  });
});
