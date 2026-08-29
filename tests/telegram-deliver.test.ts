import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Telegram alert delivery.
 *
 * Two things carry weight. The outcomes are STRUCTURED rather than thrown,
 * because the dispatcher needs to tell "this tenant never connected"
 * (record nothing) from "this tenant connected and it broke" (record an
 * honest row). And every interpolated value is escaped: alert text carries
 * customer names and free-form notes, and Telegram rejects an entire
 * message whose HTML entities will not parse, so an unescaped `<` loses the
 * alert rather than garbling it.
 */

vi.mock("@/lib/db/coworker-connections", () => ({ getCoworkerConnection: vi.fn() }));
vi.mock("@/lib/coworker-channels/tier-gate", () => ({
  coworkerChannelAllowedForBusiness: vi.fn()
}));
vi.mock("@/lib/telegram/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telegram/client")>()),
  telegramSendMessage: vi.fn()
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { deliverTelegramAlert, telegramAlertTargetState } from "@/lib/telegram/deliver";
import { getCoworkerConnection } from "@/lib/db/coworker-connections";
import { coworkerChannelAllowedForBusiness } from "@/lib/coworker-channels/tier-gate";
import { telegramSendMessage } from "@/lib/telegram/client";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONNECTED = {
  business_id: BIZ,
  credential: "123:AA",
  is_active: true,
  alert_target_id: "-100777"
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCoworkerConnection).mockResolvedValue(CONNECTED as never);
  vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(true);
  vi.mocked(telegramSendMessage).mockResolvedValue({ messageId: "9", chatId: "-100777" });
});

describe("the alert card", () => {
  /** The text that actually reached Telegram on the one send we made. */
  const sentText = () => vi.mocked(telegramSendMessage).mock.calls[0][1].text;

  it("escapes every interpolated part", async () => {
    await deliverTelegramAlert({
      businessId: BIZ,
      summary: "New lead <Dana & Co>",
      details: "note: a > b"
    });
    expect(sentText()).toContain("&lt;Dana &amp; Co&gt;");
    expect(sentText()).toContain("a &gt; b");
  });

  it("escapes a quote in the href, so a URL cannot close the attribute", async () => {
    // The text escaper leaves `"` alone, which inside an attribute would end
    // it early and let whatever followed be parsed as further markup.
    await deliverTelegramAlert({
      businessId: BIZ,
      summary: "x",
      detailsUrl: 'https://app/x?q="onmouseover=1'
    });
    expect(sentText()).toContain("&quot;");
    expect(sentText()).not.toMatch(/href="[^"]*"[^>]/);
  });

  it("links to the dashboard when the URL is http(s)", async () => {
    await deliverTelegramAlert({ businessId: BIZ, summary: "x", detailsUrl: "https://app/x" });
    expect(sentText()).toContain('<a href="https://app/x">');
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "  ", "ftp://x"])(
    "refuses to publish %s as a link",
    async (url) => {
      // We would be publishing this on the tenant's behalf, in their chat.
      await deliverTelegramAlert({ businessId: BIZ, summary: "x", detailsUrl: url });
      expect(sentText()).not.toContain("<a href");
    }
  );

  it("omits an empty details block rather than leaving a gap", async () => {
    await deliverTelegramAlert({ businessId: BIZ, summary: "x", details: "   " });
    expect(sentText()).toBe("<b>x</b>");
  });
});

describe("delivery outcomes", () => {
  it("sends to the picked chat and reports the ids", async () => {
    expect(await deliverTelegramAlert({ businessId: BIZ, summary: "New lead" })).toEqual({
      ok: true,
      chatId: "-100777",
      messageId: "9"
    });
  });

  it.each([
    ["never connected", null, "not_connected"],
    ["paused", { ...CONNECTED, is_active: false }, "needs_reconnect"],
    ["credential unreadable", { ...CONNECTED, credential: "" }, "needs_reconnect"],
    ["no chat picked", { ...CONNECTED, alert_target_id: null }, "no_alert_target"]
  ])("reports %s as %s", async (_label, row, reason) => {
    vi.mocked(getCoworkerConnection).mockResolvedValue(row as never);
    expect(await deliverTelegramAlert({ businessId: BIZ, summary: "x" })).toEqual({
      ok: false,
      reason
    });
    expect(telegramSendMessage).not.toHaveBeenCalled();
  });

  it("refuses on a downgraded plan without deleting anything", async () => {
    vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(false);
    expect(await deliverTelegramAlert({ businessId: BIZ, summary: "x" })).toEqual({
      ok: false,
      reason: "tier_blocked"
    });
  });

  it("delivers anyway when the tier check is down", async () => {
    // An alert must never be lost to a transient tier lookup blip.
    vi.mocked(coworkerChannelAllowedForBusiness).mockRejectedValue(new Error("db down"));
    expect(await deliverTelegramAlert({ businessId: BIZ, summary: "x" })).toMatchObject({
      ok: true
    });
  });

  it("reports a send failure with its detail rather than throwing", async () => {
    vi.mocked(telegramSendMessage).mockRejectedValue(new Error("bot was blocked by the user"));
    expect(await deliverTelegramAlert({ businessId: BIZ, summary: "x" })).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "bot was blocked by the user"
    });
  });

  it("reports a connection read failure as a send failure, not as unconnected", async () => {
    // "Never connected" records NO row. A read blip must not be mistaken
    // for that, or a broken channel looks like an unused one.
    vi.mocked(getCoworkerConnection).mockRejectedValue(new Error("db down"));
    expect(await deliverTelegramAlert({ businessId: BIZ, summary: "x" })).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "connection_read_failed"
    });
  });
});

describe("failures that are not Errors", () => {
  it.each([
    ["the connection read", () => vi.mocked(getCoworkerConnection).mockRejectedValue("boom")],
    ["the send", () => vi.mocked(telegramSendMessage).mockRejectedValue("boom")]
  ])("stringifies %s", async (_label, arrange) => {
    arrange();
    expect(await deliverTelegramAlert({ businessId: BIZ, summary: "x" })).toMatchObject({
      ok: false,
      reason: "send_failed"
    });
  });

  it("stringifies a non-Error tier check failure and still delivers", async () => {
    vi.mocked(coworkerChannelAllowedForBusiness).mockRejectedValue("boom");
    expect(await deliverTelegramAlert({ businessId: BIZ, summary: "x" })).toMatchObject({
      ok: true
    });
  });

  it("stringifies a non-Error probe failure and fails toward connected", async () => {
    vi.mocked(getCoworkerConnection).mockRejectedValue("boom");
    expect(await telegramAlertTargetState(BIZ)).toEqual({ connected: true, hasTarget: true });
  });
});

describe("the applicability probe", () => {
  it("reports a connected tenant with a target", async () => {
    expect(await telegramAlertTargetState(BIZ)).toEqual({ connected: true, hasTarget: true });
  });

  it("reports a never-connected tenant", async () => {
    vi.mocked(getCoworkerConnection).mockResolvedValue(null);
    expect(await telegramAlertTargetState(BIZ)).toEqual({ connected: false, hasTarget: false });
  });

  it("fails toward CONNECTED, so a read blip is a noisy skip not silence", async () => {
    vi.mocked(getCoworkerConnection).mockRejectedValue(new Error("db down"));
    expect(await telegramAlertTargetState(BIZ)).toEqual({ connected: true, hasTarget: true });
  });
});
