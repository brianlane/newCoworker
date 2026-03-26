import { describe, expect, it, vi } from "vitest";
import { sendOwnerEmail } from "@/lib/email/client";

describe("email client", () => {
  it("returns email id from resend response", async () => {
    const sendMock = vi.fn(async () => ({ data: { id: "email_1" } }));
    class MockResend {
      emails = { send: sendMock };
      constructor(_key: string) {}
    }

    const id = await sendOwnerEmail(
      "re_key",
      "owner@example.com",
      "Urgent",
      "Body",
      undefined,
      MockResend as any
    );

    expect(id).toBe("email_1");
  });

  it("returns null when id is missing", async () => {
    const sendMock = vi.fn(async () => ({ data: null }));
    class MockResend {
      emails = { send: sendMock };
      constructor(_key: string) {}
    }

    const id = await sendOwnerEmail(
      "re_key",
      "owner@example.com",
      "Urgent",
      "Body",
      undefined,
      MockResend as any
    );

    expect(id).toBeNull();
  });
});
