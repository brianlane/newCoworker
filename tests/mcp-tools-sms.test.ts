import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async (_auth, explicit?: string) => explicit ?? "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/telnyx/messaging", () => ({
  getTelnyxMessagingForBusiness: vi.fn(),
  sendTelnyxSms: vi.fn()
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const insertMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({
    from: vi.fn(() => ({ insert: insertMock }))
  }))
}));

import { requireMcpBusinessRole } from "@/lib/mcp/auth";
import { sendSmsTool } from "@/lib/mcp/tools/sms";
import { rateLimit } from "@/lib/rate-limit";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { logger } from "@/lib/logger";

const AUTH = { userId: "user-1", email: "owner@biz.com" };
const CONFIG = {
  apiKey: "k",
  messagingProfileId: "p",
  fromE164: "+15559998888"
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMcpBusinessRole).mockResolvedValue("owner");
  vi.mocked(rateLimit).mockReturnValue({
    success: true,
    limit: 60,
    remaining: 59,
    reset: 0
  });
  vi.mocked(getTelnyxMessagingForBusiness).mockResolvedValue(CONFIG);
  vi.mocked(sendTelnyxSms).mockResolvedValue({ id: "msg-1", channel: "sms" } as never);
  insertMock.mockResolvedValue({ error: null });
});

describe("send_sms", () => {
  it("sends through the metered path and logs with source mcp", async () => {
    const result = await sendSmsTool.handler(
      { to: "555-000-1111", text: "hello" },
      AUTH
    );
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "operate_messages");
    expect(sendTelnyxSms).toHaveBeenCalledWith(CONFIG, "+15550001111", "hello", {
      meterBusinessId: "biz-1"
    });
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-1",
        to_e164: "+15550001111",
        from_e164: "+15559998888",
        body: "hello",
        source: "mcp",
        telnyx_message_id: "msg-1",
        channel: "sms"
      })
    );
    expect(result).toEqual({
      sent: true,
      to: "+15550001111",
      message_id: "msg-1",
      channel: "sms"
    });
  });

  it("nulls the from number in the log when unset", async () => {
    vi.mocked(getTelnyxMessagingForBusiness).mockResolvedValue({
      apiKey: "k",
      messagingProfileId: "p"
    });
    await sendSmsTool.handler({ to: "+15550001111", text: "x" }, AUTH);
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ from_e164: null }));
  });

  it("refuses when the per-business rate limit is hit", async () => {
    vi.mocked(rateLimit).mockReturnValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: 0
    });
    await expect(
      sendSmsTool.handler({ to: "+15550001111", text: "x" }, AUTH)
    ).rejects.toThrow(/rate limit/i);
    expect(sendTelnyxSms).not.toHaveBeenCalled();
  });

  it("surfaces quota/send failures as tool errors", async () => {
    vi.mocked(sendTelnyxSms).mockRejectedValue(new Error("Monthly SMS limit reached"));
    await expect(
      sendSmsTool.handler({ to: "+15550001111", text: "x" }, AUTH)
    ).rejects.toThrow(/Could not send: Monthly SMS limit reached/);

    vi.mocked(sendTelnyxSms).mockRejectedValue("weird failure");
    await expect(
      sendSmsTool.handler({ to: "+15550001111", text: "x" }, AUTH)
    ).rejects.toThrow(/Could not send: weird failure/);
  });

  it("still reports success when the outbound log insert fails", async () => {
    insertMock.mockResolvedValue({ error: { message: "insert down" } });
    const result = (await sendSmsTool.handler(
      { to: "+15550001111", text: "x" },
      AUTH
    )) as { sent: boolean };
    expect(result.sent).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      "mcp sms: outbound log insert failed",
      expect.objectContaining({ error: "insert down" })
    );
  });
});
