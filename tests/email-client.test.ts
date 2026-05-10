import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { sendOwnerEmail } from "@/lib/email/client";

describe("email client", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns email id from resend response and passes correct payload", async () => {
    const sendMock = vi.fn(async () => ({ data: { id: "email_1" } }));
    class MockResend {
      emails = { send: sendMock };
      constructor(_key: string) {}
    }

    process.env.CONTACT_EMAIL = "reply@example.com";
    process.env.MAILER_EMAIL = "sender@example.com";

    const id = await sendOwnerEmail(
      "re_key",
      "owner@example.com",
      "Urgent",
      "Body",
      undefined,
      MockResend as any
    );

    expect(id).toBe("email_1");
    expect(sendMock).toHaveBeenCalledWith({
      from: "sender@example.com",
      to: "owner@example.com",
      subject: "Urgent",
      text: "Body",
      replyTo: "reply@example.com"
    });
  });

  it("returns null when id is missing", async () => {
    const sendMock = vi.fn(async () => ({ data: null }));
    class MockResend {
      emails = { send: sendMock };
      constructor(_key: string) {}
    }

    delete process.env.CONTACT_EMAIL;
    delete process.env.MAILER_EMAIL;

    const id = await sendOwnerEmail(
      "re_key",
      "owner@example.com",
      "Urgent",
      "Body",
      undefined,
      MockResend as any
    );

    expect(id).toBeNull();
    expect(sendMock).toHaveBeenCalledWith({
      from: "New Coworker <contact@newcoworker.com>",
      to: "owner@example.com",
      subject: "Urgent",
      text: "Body"
    });
  });

  it("attaches List-Unsubscribe headers and footer when unsubscribeUrl is provided", async () => {
    const sendMock = vi.fn(async () => ({ data: { id: "id_1" } }));
    class MockResend {
      emails = { send: sendMock };
      constructor(_key: string) {}
    }
    delete process.env.CONTACT_EMAIL;
    process.env.MAILER_EMAIL = "sender@example.com";

    await sendOwnerEmail(
      "re_key",
      "owner@example.com",
      "Urgent",
      {
        text: "Body content",
        unsubscribeUrl: "https://app.example.com/api/notifications/unsubscribe?token=t",
        resendCtor: MockResend as never
      }
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    const calls = sendMock.mock.calls as unknown as Array<Array<Record<string, unknown>>>;
    const payload = calls[0][0];
    expect(payload.headers).toEqual({
      "List-Unsubscribe":
        "<https://app.example.com/api/notifications/unsubscribe?token=t>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
    });
    expect(payload.text).toContain("Body content");
    expect(payload.text).toContain(
      "Unsubscribe with one click: https://app.example.com/api/notifications/unsubscribe?token=t"
    );
  });

  it("omits headers when unsubscribeUrl is not set (options-bag form)", async () => {
    const sendMock = vi.fn(async () => ({ data: { id: "id_2" } }));
    class MockResend {
      emails = { send: sendMock };
      constructor(_key: string) {}
    }
    delete process.env.CONTACT_EMAIL;
    process.env.MAILER_EMAIL = "sender@example.com";

    await sendOwnerEmail("re_key", "owner@example.com", "Hello", {
      text: "Plain body",
      resendCtor: MockResend as never
    });
    const calls = sendMock.mock.calls as unknown as Array<Array<Record<string, unknown>>>;
    const payload = calls[0][0];
    expect(payload.headers).toBeUndefined();
    expect(payload.text).toBe("Plain body");
  });

  it("forwards html body when supplied via options bag", async () => {
    const sendMock = vi.fn(async () => ({ data: { id: "id_3" } }));
    class MockResend {
      emails = { send: sendMock };
      constructor(_key: string) {}
    }
    delete process.env.CONTACT_EMAIL;
    process.env.MAILER_EMAIL = "sender@example.com";
    await sendOwnerEmail("re_key", "owner@example.com", "Hi", {
      text: "Plain body",
      html: "<p>Plain body</p>",
      resendCtor: MockResend as never
    });
    const calls = sendMock.mock.calls as unknown as Array<Array<Record<string, unknown>>>;
    expect(calls[0][0].html).toBe("<p>Plain body</p>");
  });

  it("uses opts.from override when provided in options bag", async () => {
    const sendMock = vi.fn(async () => ({ data: { id: "id_4" } }));
    class MockResend {
      emails = { send: sendMock };
      constructor(_key: string) {}
    }
    process.env.MAILER_EMAIL = "default@example.com";
    await sendOwnerEmail("re_key", "owner@example.com", "Hi", {
      text: "body",
      from: "custom@example.com",
      resendCtor: MockResend as never
    });
    const calls = sendMock.mock.calls as unknown as Array<Array<Record<string, unknown>>>;
    expect(calls[0][0].from).toBe("custom@example.com");
  });

  it("falls back to hard-coded default from when env is unset and no override", async () => {
    const sendMock = vi.fn(async () => ({ data: { id: "id_5" } }));
    class MockResend {
      emails = { send: sendMock };
      constructor(_key: string) {}
    }
    delete process.env.MAILER_EMAIL;
    delete process.env.CONTACT_EMAIL;
    await sendOwnerEmail("re_key", "owner@example.com", "Hi", {
      text: "body",
      resendCtor: MockResend as never
    });
    const calls = sendMock.mock.calls as unknown as Array<Array<Record<string, unknown>>>;
    expect(calls[0][0].from).toBe("New Coworker <contact@newcoworker.com>");
  });

  it("uses legacyResendCtor when options.resendCtor is omitted", async () => {
    const sendMock = vi.fn(async () => ({ data: { id: "id_6" } }));
    class MockResend {
      emails = { send: sendMock };
      constructor(_key: string) {}
    }
    delete process.env.CONTACT_EMAIL;
    process.env.MAILER_EMAIL = "sender@example.com";
    // Options bag without resendCtor: the function should fall through to the
    // legacyResendCtor positional default (passed here as MockResend).
    await sendOwnerEmail(
      "re_key",
      "owner@example.com",
      "Hi",
      { text: "body" },
      undefined,
      MockResend as never
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("substitutes empty string when text is omitted from options", async () => {
    const sendMock = vi.fn(async () => ({ data: { id: "id_7" } }));
    class MockResend {
      emails = { send: sendMock };
      constructor(_key: string) {}
    }
    delete process.env.CONTACT_EMAIL;
    process.env.MAILER_EMAIL = "sender@example.com";
    await sendOwnerEmail("re_key", "owner@example.com", "Hi", {
      resendCtor: MockResend as never
    });
    const calls = sendMock.mock.calls as unknown as Array<Array<Record<string, unknown>>>;
    expect(calls[0][0].text).toBe("");
  });
});
