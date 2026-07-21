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
vi.mock("@/lib/whatsapp/deliver", () => ({ deliverWhatsApp: vi.fn() }));
vi.mock("@/lib/customer-memory/db", () => ({ recordInteractionAndIncrement: vi.fn() }));
// An owner-initiated outbound must never fire lead-follow-up automations:
// the tools use the rollup directly, so the contact_created hook stays cold.
vi.mock("@/lib/ai-flows/contact-event-hooks", () => ({ fireContactEvent: vi.fn() }));

const insertMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({
    from: vi.fn(() => ({ insert: insertMock }))
  }))
}));

import { requireMcpBusinessRole } from "@/lib/mcp/auth";
import { sendSmsTool, sendWhatsAppTool } from "@/lib/mcp/tools/sms";
import { rateLimit } from "@/lib/rate-limit";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { deliverWhatsApp } from "@/lib/whatsapp/deliver";
import { logger } from "@/lib/logger";
import { recordInteractionAndIncrement } from "@/lib/customer-memory/db";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";

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
  vi.mocked(recordInteractionAndIncrement).mockResolvedValue({} as never);
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

  it("tells the composing model to include timezones on quoted times (KYP/Ayanna Jul 20 2026)", () => {
    // The body is authored by the connected model, so the tool description is
    // the lever: a "3:00 PM" confirmation with no timezone sent a Central-time
    // lead the wrong hour for an Eastern-time call.
    expect(sendSmsTool.description).toMatch(/timezone/i);
    expect(sendWhatsAppTool.description).toMatch(/timezone/i);
  });

  it("upserts the recipient as a contact after a successful send (outbound-first numbers must exist)", async () => {
    await sendSmsTool.handler({ to: "555-000-1111", text: "hello" }, AUTH);
    expect(recordInteractionAndIncrement).toHaveBeenCalledWith(
      "biz-1",
      "+15550001111",
      "sms",
      { displayName: null },
      expect.anything()
    );
    // Rollup only — owner-initiated outreach must never trigger
    // contact_created lead-follow-up automations.
    expect(fireContactEvent).not.toHaveBeenCalled();
  });

  it("passes contact_name through to the upsert (existing names are never clobbered by the RPC)", async () => {
    await sendSmsTool.handler(
      { to: "+13127310559", text: "hello", contact_name: "  Ayanna  " },
      AUTH
    );
    expect(recordInteractionAndIncrement).toHaveBeenCalledWith(
      "biz-1",
      "+13127310559",
      "sms",
      { displayName: "Ayanna" },
      expect.anything()
    );
  });

  it("a failed contact upsert logs and never fails the sent message (Error AND string shapes)", async () => {
    vi.mocked(recordInteractionAndIncrement).mockRejectedValue(new Error("rollup down"));
    const result = (await sendSmsTool.handler(
      { to: "+15550001111", text: "x" },
      AUTH
    )) as { sent: boolean };
    expect(result.sent).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "mcp sms: contact upsert failed",
      expect.objectContaining({ error: "rollup down" })
    );

    vi.mocked(recordInteractionAndIncrement).mockRejectedValue("rollup string blast");
    const again = (await sendSmsTool.handler(
      { to: "+15550001111", text: "x" },
      AUTH
    )) as { sent: boolean };
    expect(again.sent).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "mcp sms: contact upsert failed",
      expect.objectContaining({ error: "rollup string blast" })
    );
  });

  it("skips the contact upsert when the send itself failed", async () => {
    vi.mocked(sendTelnyxSms).mockRejectedValue(new Error("Monthly SMS limit reached"));
    await expect(
      sendSmsTool.handler({ to: "+15550001111", text: "x" }, AUTH)
    ).rejects.toThrow(/Could not send/);
    expect(recordInteractionAndIncrement).not.toHaveBeenCalled();
  });
});

describe("send_whatsapp", () => {
  it("delivers through the central helper and reports the delivery path", async () => {
    vi.mocked(deliverWhatsApp).mockResolvedValue({
      ok: true,
      via: "template",
      messageId: "wamid-1"
    } as never);
    const result = await sendWhatsAppTool.handler(
      { to: "555-000-1111", text: "hello" },
      AUTH
    );
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "operate_messages");
    expect(deliverWhatsApp).toHaveBeenCalledWith({
      businessId: "biz-1",
      to: "+15550001111",
      text: "hello",
      audience: "contact"
    });
    expect(result).toEqual({
      sent: true,
      to: "+15550001111",
      message_id: "wamid-1",
      via: "template"
    });
  });

  it("refuses when the per-business rate limit is hit", async () => {
    vi.mocked(rateLimit).mockReturnValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: 0
    });
    await expect(
      sendWhatsAppTool.handler({ to: "+15550001111", text: "x" }, AUTH)
    ).rejects.toThrow(/rate limit/i);
    expect(deliverWhatsApp).not.toHaveBeenCalled();
  });

  it("upserts the recipient as a contact after a successful delivery (whatsapp channel)", async () => {
    vi.mocked(deliverWhatsApp).mockResolvedValue({
      ok: true,
      via: "text",
      messageId: "wamid-9"
    } as never);
    await sendWhatsAppTool.handler(
      { to: "+13127310559", text: "hello", contact_name: "Ayanna" },
      AUTH
    );
    expect(recordInteractionAndIncrement).toHaveBeenCalledWith(
      "biz-1",
      "+13127310559",
      "whatsapp",
      { displayName: "Ayanna" },
      expect.anything()
    );
    expect(fireContactEvent).not.toHaveBeenCalled();
  });

  it("a failed contact upsert logs and never fails the delivered message", async () => {
    vi.mocked(deliverWhatsApp).mockResolvedValue({
      ok: true,
      via: "text",
      messageId: "wamid-10"
    } as never);
    vi.mocked(recordInteractionAndIncrement).mockRejectedValue(new Error("rollup down"));
    const result = (await sendWhatsAppTool.handler(
      { to: "+15550001111", text: "x" },
      AUTH
    )) as { sent: boolean };
    expect(result.sent).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "mcp whatsapp: contact upsert failed",
      expect.objectContaining({ error: "rollup down" })
    );
  });

  it("maps policy skips and failures to actionable tool errors", async () => {
    vi.mocked(deliverWhatsApp).mockResolvedValue({
      ok: false,
      reason: "not_connected"
    } as never);
    await expect(
      sendWhatsAppTool.handler({ to: "+15550001111", text: "x" }, AUTH)
    ).rejects.toThrow(/not connected/i);

    vi.mocked(deliverWhatsApp).mockResolvedValue({
      ok: false,
      reason: "template_not_approved"
    } as never);
    await expect(
      sendWhatsAppTool.handler({ to: "+15550001111", text: "x" }, AUTH)
    ).rejects.toThrow(/use send_sms instead/i);

    vi.mocked(deliverWhatsApp).mockResolvedValue({
      ok: false,
      reason: "send_failed",
      detail: "cloud api 500"
    } as never);
    await expect(
      sendWhatsAppTool.handler({ to: "+15550001111", text: "x" }, AUTH)
    ).rejects.toThrow(/Could not send: send_failed \(cloud api 500\)/);

    vi.mocked(deliverWhatsApp).mockResolvedValue({
      ok: false,
      reason: "invalid_recipient"
    } as never);
    await expect(
      sendWhatsAppTool.handler({ to: "+15550001111", text: "x" }, AUTH)
    ).rejects.toThrow(/Could not send: invalid_recipient/);
    // No delivery → no contact upsert.
    expect(recordInteractionAndIncrement).not.toHaveBeenCalled();
  });
});
