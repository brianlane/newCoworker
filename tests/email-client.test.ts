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
});
