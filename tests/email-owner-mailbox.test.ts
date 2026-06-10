import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/voice-tools/connections", () => ({
  resolveEmailConnection: vi.fn()
}));

vi.mock("@/lib/nango/workspace", () => ({
  nangoProxyForBusiness: vi.fn()
}));

import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import { resolveEmailConnection } from "@/lib/voice-tools/connections";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";

const BIZ = "11111111-1111-4111-8111-111111111111";
const ARGS = { toEmail: "lead@example.com", subject: "Hello", bodyText: "Hi there" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendFromOwnerMailbox", () => {
  it("returns email_not_connected when no connection is linked", async () => {
    vi.mocked(resolveEmailConnection).mockResolvedValue(null);
    await expect(sendFromOwnerMailbox(BIZ, ARGS)).resolves.toEqual({
      ok: false,
      detail: "email_not_connected"
    });
    expect(nangoProxyForBusiness).not.toHaveBeenCalled();
  });

  it("sends base64url RFC2822 via Gmail for google connections", async () => {
    vi.mocked(resolveEmailConnection).mockResolvedValue({
      provider: "google",
      providerConfigKey: "google-mail",
      connectionId: "cx-1"
    });
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "gmail-1" } } as never);

    await expect(sendFromOwnerMailbox(BIZ, ARGS)).resolves.toEqual({
      ok: true,
      provider: "google",
      messageId: "gmail-1"
    });
    const call = vi.mocked(nangoProxyForBusiness).mock.calls[0];
    expect(call[2]).toMatchObject({ endpoint: "/gmail/v1/users/me/messages/send", method: "POST" });
    const raw = (call[2] as { data: { raw: string } }).data.raw;
    expect(raw).not.toMatch(/[+/=]/);
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded).toContain("To: lead@example.com");
    expect(decoded).toContain("Subject: Hello");
  });

  it("returns a null messageId when Gmail omits the id", async () => {
    vi.mocked(resolveEmailConnection).mockResolvedValue({
      provider: "google",
      providerConfigKey: "gmail",
      connectionId: "cx-1"
    });
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    await expect(sendFromOwnerMailbox(BIZ, ARGS)).resolves.toEqual({
      ok: true,
      provider: "google",
      messageId: null
    });
  });

  it("returns email_not_connected when the google proxy can't verify the link", async () => {
    vi.mocked(resolveEmailConnection).mockResolvedValue({
      provider: "google",
      providerConfigKey: "google-mail",
      connectionId: "cx-1"
    });
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null);
    await expect(sendFromOwnerMailbox(BIZ, ARGS)).resolves.toEqual({
      ok: false,
      detail: "email_not_connected"
    });
  });

  it("sends via Microsoft Graph sendMail for outlook connections", async () => {
    vi.mocked(resolveEmailConnection).mockResolvedValue({
      provider: "microsoft",
      providerConfigKey: "outlook",
      connectionId: "cx-ms"
    });
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);

    await expect(sendFromOwnerMailbox(BIZ, ARGS)).resolves.toEqual({
      ok: true,
      provider: "microsoft",
      messageId: null
    });
    const call = vi.mocked(nangoProxyForBusiness).mock.calls[0];
    expect(call[2]).toMatchObject({ endpoint: "/v1.0/me/sendMail", method: "POST" });
    const data = (call[2] as { data: { message: { toRecipients: Array<{ emailAddress: { address: string } }> }; saveToSentItems: boolean } }).data;
    expect(data.message.toRecipients[0].emailAddress.address).toBe("lead@example.com");
    expect(data.saveToSentItems).toBe(true);
  });

  it("returns email_not_connected when the microsoft proxy can't verify the link", async () => {
    vi.mocked(resolveEmailConnection).mockResolvedValue({
      provider: "microsoft",
      providerConfigKey: "outlook",
      connectionId: "cx-ms"
    });
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null);
    await expect(sendFromOwnerMailbox(BIZ, ARGS)).resolves.toEqual({
      ok: false,
      detail: "email_not_connected"
    });
  });

  it("propagates provider errors to the caller (adapters map them to email_send_failed)", async () => {
    vi.mocked(resolveEmailConnection).mockResolvedValue({
      provider: "google",
      providerConfigKey: "google-mail",
      connectionId: "cx-1"
    });
    vi.mocked(nangoProxyForBusiness).mockRejectedValue(new Error("gmail 500"));
    await expect(sendFromOwnerMailbox(BIZ, ARGS)).rejects.toThrow("gmail 500");
  });
});
