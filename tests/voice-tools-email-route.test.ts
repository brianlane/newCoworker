import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/voice-tools/connections", () => ({
  resolveEmailConnection: vi.fn()
}));

vi.mock("@/lib/nango/workspace", () => ({
  nangoProxyForBusiness: vi.fn()
}));

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn().mockReturnValue(true)
}));

import { POST } from "@/app/api/voice/tools/email/route";
import { resolveEmailConnection } from "@/lib/voice-tools/connections";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { verifyRowboatGatewayToken } from "@/lib/rowboat/gateway-token";

const businessId = "11111111-1111-4111-8111-111111111111";

function makeRequest(body: unknown, token = "gw") {
  return new Request("http://localhost/api/voice/tools/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
}

describe("POST /api/voice/tools/email", () => {
  const OLD = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD, ROWBOAT_GATEWAY_TOKEN: "gw" };
    vi.mocked(verifyRowboatGatewayToken).mockReturnValue(true);
  });

  afterEach(() => {
    process.env = OLD;
  });

  it("rejects requests without a gateway token", async () => {
    vi.mocked(verifyRowboatGatewayToken).mockReturnValue(false);
    const res = await POST(makeRequest({ businessId, args: { toEmail: "x@y.com", subject: "s", bodyText: "b" } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, detail: "unauthorized" });
  });

  it("rejects malformed args with a zod detail", async () => {
    const res = await POST(makeRequest({ businessId, args: { toEmail: "not-an-email", subject: "s", bodyText: "b" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.detail).toMatch(/^invalid_args:/);
  });

  it("returns email_not_connected when no Nango connection exists (per require_nango product rule)", async () => {
    vi.mocked(resolveEmailConnection).mockResolvedValue(null);
    const res = await POST(
      makeRequest({
        businessId,
        args: { toEmail: "lead@example.com", subject: "Follow-up", bodyText: "Thanks for calling" }
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "email_not_connected" });
    expect(nangoProxyForBusiness).not.toHaveBeenCalled();
  });

  it("sends a base64url RFC2822 body via Gmail when Google is connected", async () => {
    vi.mocked(resolveEmailConnection).mockResolvedValue({
      provider: "google",
      providerConfigKey: "google-mail",
      connectionId: "cx-1"
    });
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({
      data: { id: "gmail-abc" }
    } as never);

    const res = await POST(
      makeRequest({
        businessId,
        args: { toEmail: "lead@example.com", subject: "Follow-up", bodyText: "Thanks." }
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, data: { messageId: "gmail-abc", provider: "google" } });

    expect(nangoProxyForBusiness).toHaveBeenCalledOnce();
    const call = vi.mocked(nangoProxyForBusiness).mock.calls[0];
    expect(call[0]).toBe(businessId);
    expect(call[1]).toEqual({ connectionId: "cx-1", providerConfigKey: "google-mail" });
    expect(call[2]).toMatchObject({ endpoint: "/gmail/v1/users/me/messages/send", method: "POST" });
    const payload = call[2] as { data: { raw: string } };
    expect(typeof payload.data.raw).toBe("string");
    // base64url — no '+' or '/' or '=' padding
    expect(payload.data.raw).not.toMatch(/[+/=]/);
    const decoded = Buffer.from(payload.data.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded).toMatch(/To: lead@example.com/);
    expect(decoded).toMatch(/Subject: Follow-up/);
    expect(decoded).toMatch(/Thanks\./);
  });

  it("falls back to Microsoft Graph sendMail for outlook connections", async () => {
    vi.mocked(resolveEmailConnection).mockResolvedValue({
      provider: "microsoft",
      providerConfigKey: "outlook",
      connectionId: "cx-ms"
    });
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);

    const res = await POST(
      makeRequest({
        businessId,
        args: { toEmail: "lead@example.com", subject: "Follow-up", bodyText: "Thanks." }
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { messageId: null, provider: "microsoft" } });

    const call = vi.mocked(nangoProxyForBusiness).mock.calls[0];
    expect(call[2]).toMatchObject({ endpoint: "/v1.0/me/sendMail", method: "POST" });
    const msg = (call[2] as { data: { message: { toRecipients: Array<{ emailAddress: { address: string } }> } } }).data.message;
    expect(msg.toRecipients[0].emailAddress.address).toBe("lead@example.com");
  });

  it("returns email_send_failed on upstream error", async () => {
    vi.mocked(resolveEmailConnection).mockResolvedValue({
      provider: "google",
      providerConfigKey: "google-mail",
      connectionId: "cx-1"
    });
    vi.mocked(nangoProxyForBusiness).mockRejectedValue(new Error("boom"));

    const res = await POST(
      makeRequest({
        businessId,
        args: { toEmail: "lead@example.com", subject: "Follow-up", bodyText: "Thanks." }
      })
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, detail: "email_send_failed" });
  });
});
