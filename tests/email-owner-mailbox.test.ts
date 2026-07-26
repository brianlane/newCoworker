import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/voice-tools/connections", () => ({
  resolveEmailConnection: vi.fn()
}));

vi.mock("@/lib/nango/workspace", () => ({
  nangoProxyForBusiness: vi.fn()
}));

import { sendFromMailboxConnection, sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
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
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({
      data: { id: "gmail-1", threadId: "thread-1" }
    } as never);

    await expect(sendFromOwnerMailbox(BIZ, ARGS)).resolves.toEqual({
      ok: true,
      provider: "google",
      messageId: "gmail-1",
      // Gmail reports the conversation the message landed in; the email
      // coworker claims ownership of that thread from this value.
      threadId: "thread-1"
    });
    const call = vi.mocked(nangoProxyForBusiness).mock.calls[0];
    expect(call[2]).toMatchObject({ endpoint: "/gmail/v1/users/me/messages/send", method: "POST" });
    const raw = (call[2] as { data: { raw: string } }).data.raw;
    expect(raw).not.toMatch(/[+/=]/);
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded).toContain("To: lead@example.com");
    expect(decoded).toContain("Subject: Hello");
  });

  it("adds Cc and Bcc header lines to the Gmail MIME when present", async () => {
    vi.mocked(resolveEmailConnection).mockResolvedValue({
      provider: "google",
      providerConfigKey: "google-mail",
      connectionId: "cx-1"
    });
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "gmail-cc" } } as never);

    await sendFromOwnerMailbox(BIZ, {
      ...ARGS,
      ccEmails: ["cc1@example.com", "cc2@example.com"],
      bccEmails: ["bcc@example.com"]
    });
    const call = vi.mocked(nangoProxyForBusiness).mock.calls[0];
    const raw = (call[2] as { data: { raw: string } }).data.raw;
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded).toContain("Cc: cc1@example.com, cc2@example.com");
    expect(decoded).toContain("Bcc: bcc@example.com");
  });

  it("adds ccRecipients/bccRecipients to the Microsoft payload when present", async () => {
    vi.mocked(resolveEmailConnection).mockResolvedValue({
      provider: "microsoft",
      providerConfigKey: "outlook",
      connectionId: "cx-ms"
    });
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);

    await sendFromOwnerMailbox(BIZ, {
      ...ARGS,
      ccEmails: ["cc@example.com"],
      bccEmails: ["bcc@example.com"]
    });
    const call = vi.mocked(nangoProxyForBusiness).mock.calls[0];
    const data = (
      call[2] as {
        data: {
          message: {
            ccRecipients: Array<{ emailAddress: { address: string } }>;
            bccRecipients: Array<{ emailAddress: { address: string } }>;
          };
        };
      }
    ).data;
    expect(data.message.ccRecipients[0].emailAddress.address).toBe("cc@example.com");
    expect(data.message.bccRecipients[0].emailAddress.address).toBe("bcc@example.com");
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
      messageId: null,
      threadId: null
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
      messageId: null,
      // Graph's sendMail returns no body, so there is no conversation id to
      // claim: Microsoft mailboxes send fine but cannot seed thread ownership.
      threadId: null
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

describe("sendFromMailboxConnection", () => {
  it("sends through an explicitly chosen connection (no implicit resolution)", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "gmail-2" } } as never);
    await expect(
      sendFromMailboxConnection(
        BIZ,
        { provider: "google", providerConfigKey: "gmail", connectionId: "cx-picked" },
        ARGS
      )
    ).resolves.toEqual({
      ok: true,
      provider: "google",
      messageId: "gmail-2",
      threadId: null
    });
    expect(resolveEmailConnection).not.toHaveBeenCalled();
    const call = vi.mocked(nangoProxyForBusiness).mock.calls[0];
    expect(call[1]).toMatchObject({ providerConfigKey: "gmail", connectionId: "cx-picked" });
  });
});

describe("threaded replies", () => {
  const GOOGLE = { provider: "google" as const, providerConfigKey: "gmail", connectionId: "cx" };
  const MICROSOFT = {
    provider: "microsoft" as const,
    providerConfigKey: "outlook",
    connectionId: "cx"
  };

  function decodeRaw(): string {
    const call = vi.mocked(nangoProxyForBusiness).mock.calls[0];
    const raw = (call[2] as { data: { raw: string } }).data.raw;
    return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  }

  it("Gmail: sets In-Reply-To/References AND the threadId (headers alone can split)", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({
      data: { id: "g-1", threadId: "thread-9" }
    } as never);
    const out = await sendFromMailboxConnection(BIZ, GOOGLE, {
      ...ARGS,
      thread: {
        threadId: "thread-9",
        inReplyToMessageRef: "  <beth-1@mail>  ",
        providerMessageId: "m-1"
      }
    });
    expect(out).toMatchObject({ ok: true, threadId: "thread-9" });
    const decoded = decodeRaw();
    expect(decoded).toContain("In-Reply-To: <beth-1@mail>");
    expect(decoded).toContain("References: <beth-1@mail>");
    const data = (vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as { data: { threadId: string } })
      .data;
    expect(data.threadId).toBe("thread-9");
  });

  it("Gmail: omits the headers and threadId when there is nothing to reply to", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: { id: "g-1" } } as never);
    await sendFromMailboxConnection(BIZ, GOOGLE, {
      ...ARGS,
      thread: { threadId: "   ", inReplyToMessageRef: "  " }
    });
    expect(decodeRaw()).not.toContain("In-Reply-To");
    expect(
      (vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as { data: Record<string, unknown> }).data
    ).not.toHaveProperty("threadId");
  });

  it("Graph: replies through the message's own reply action, carrying cc", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const out = await sendFromMailboxConnection(BIZ, MICROSOFT, {
      ...ARGS,
      ccEmails: ["liz@lizdev.com"],
      thread: { providerMessageId: "graph id/1", threadId: "conv-1" }
    });
    expect(out).toMatchObject({ ok: true, provider: "microsoft" });
    const call = vi.mocked(nangoProxyForBusiness).mock.calls[0];
    // The id is path-encoded: Graph ids contain / and + characters.
    expect((call[2] as { endpoint: string }).endpoint).toBe(
      `/v1.0/me/messages/${encodeURIComponent("graph id/1")}/reply`
    );
    const data = (call[2] as { data: Record<string, unknown> }).data;
    expect(data.comment).toBe(ARGS.bodyText);
    expect(data.message).toMatchObject({
      ccRecipients: [{ emailAddress: { address: "liz@lizdev.com" } }]
    });
  });

  it("Graph: a cc-less reply carries no message override, and a dead link reports honestly", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    await sendFromMailboxConnection(BIZ, MICROSOFT, {
      ...ARGS,
      thread: { providerMessageId: "m-1" }
    });
    expect(
      (vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as { data: Record<string, unknown> }).data
    ).not.toHaveProperty("message");

    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null);
    await expect(
      sendFromMailboxConnection(BIZ, MICROSOFT, {
        ...ARGS,
        thread: { providerMessageId: "m-1" }
      })
    ).resolves.toEqual({ ok: false, detail: "email_not_connected" });
  });

  it("Graph: falls back to a fresh sendMail when there is no message to reply to", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    await sendFromMailboxConnection(BIZ, MICROSOFT, {
      ...ARGS,
      thread: { threadId: "conv-1", providerMessageId: "  " }
    });
    expect(
      (vi.mocked(nangoProxyForBusiness).mock.calls[0][2] as { endpoint: string }).endpoint
    ).toBe("/v1.0/me/sendMail");
  });
});
