import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
    constructor(_apiKey: string) {}
  }
}));

vi.mock("@/lib/email/tenant-mailbox", () => ({
  ensureTenantMailbox: vi.fn(),
  tenantMailboxAddress: (localPart: string) => `${localPart}@newcoworker.com`
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { sendFromTenantMailbox } from "@/lib/email/tenant-send";
import { ensureTenantMailbox } from "@/lib/email/tenant-mailbox";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";
const ARGS = { toEmail: "lead@example.com", subject: "Hello", bodyText: "Hi there" };

/** Stub the service client so the business-name lookup resolves to `bizRow`. */
function stubBusiness(bizRow: { name?: string } | null) {
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: bizRow }) })
      })
    })
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  vi.mocked(ensureTenantMailbox).mockResolvedValue({
    business_id: BIZ,
    local_part: "amy",
    personalized: true,
    created_at: "",
    updated_at: ""
  });
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
});

describe("sendFromTenantMailbox", () => {
  it("throws when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendFromTenantMailbox(BIZ, ARGS)).rejects.toThrow("RESEND_API_KEY is not configured");
  });

  it("sends as 'Name <addr>' with cc/bcc and returns the message id", async () => {
    stubBusiness({ name: "Amy Co" });
    sendMock.mockResolvedValue({ data: { id: "resend-1" }, error: null });

    await expect(
      sendFromTenantMailbox(BIZ, {
        ...ARGS,
        ccEmails: ["cc@example.com"],
        bccEmails: ["bcc@example.com"]
      })
    ).resolves.toEqual({
      provider: "tenant",
      messageId: "resend-1",
      fromAddress: "amy@newcoworker.com",
      fromHeader: "Amy Co <amy@newcoworker.com>"
    });
    const payload = sendMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      from: "Amy Co <amy@newcoworker.com>",
      to: "lead@example.com",
      replyTo: "amy@newcoworker.com",
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"]
    });
  });

  it("falls back to the bare address when the business has no name; null id when Resend omits it", async () => {
    stubBusiness(null);
    sendMock.mockResolvedValue({ data: {}, error: null });

    await expect(sendFromTenantMailbox(BIZ, ARGS)).resolves.toEqual({
      provider: "tenant",
      messageId: null,
      fromAddress: "amy@newcoworker.com",
      fromHeader: "amy@newcoworker.com"
    });
    const payload = sendMock.mock.calls[0][0];
    expect(payload.from).toBe("amy@newcoworker.com");
    expect(payload.cc).toBeUndefined();
    expect(payload.bcc).toBeUndefined();
  });

  it("uses the bare address when the business row has no name field, and surfaces the Resend error message", async () => {
    stubBusiness({});
    sendMock.mockResolvedValue({ data: null, error: { message: "domain not verified" } });
    await expect(sendFromTenantMailbox(BIZ, ARGS)).rejects.toThrow("domain not verified");
  });

  it("throws a generic message when Resend errors without a message", async () => {
    stubBusiness({ name: "Amy Co" });
    sendMock.mockResolvedValue({ data: null, error: {} });
    await expect(sendFromTenantMailbox(BIZ, ARGS)).rejects.toThrow("Resend send failed");
  });
});
