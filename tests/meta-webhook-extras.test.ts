/**
 * The three previously-dropped Meta webhook families
 * (src/lib/meta/webhook-extras.ts).
 *
 * The property that matters most is in processMetaEchoEvent: our OWN reply
 * echoes back on the same field a colleague's does, and recording ours as an
 * owner turn would silence the AI immediately after it spoke and stall every
 * conversation. app_id is what separates them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/db/meta-connections", () => ({
  getActiveMetaConnectionByPageId: vi.fn(),
  getActiveMetaConnectionByInstagramId: vi.fn()
}));
vi.mock("@/lib/messenger/db", () => ({
  appendMessengerMessage: vi.fn(),
  findMessengerConversation: vi.fn(),
  setMessengerConversationReferral: vi.fn()
}));
vi.mock("@/lib/db/whatsapp-connections", () => ({
  getWhatsAppConnectionByWabaId: vi.fn(),
  updateWhatsAppTemplates: vi.fn()
}));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));

import {
  processMetaEchoEvent,
  processMetaReferralEvent,
  processMetaTemplateStatusEvent
} from "@/lib/meta/webhook-extras";
import {
  getActiveMetaConnectionByInstagramId,
  getActiveMetaConnectionByPageId
} from "@/lib/db/meta-connections";
import {
  appendMessengerMessage,
  findMessengerConversation,
  setMessengerConversationReferral
} from "@/lib/messenger/db";
import {
  getWhatsAppConnectionByWabaId,
  updateWhatsAppTemplates
} from "@/lib/db/whatsapp-connections";
import { recordSystemLog } from "@/lib/db/system-logs";
import { META_PAGE_INBOX_APP_ID } from "@/lib/meta/client";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OUR_APP = "1554839372962421";

const byPage = vi.mocked(getActiveMetaConnectionByPageId);
const byIg = vi.mocked(getActiveMetaConnectionByInstagramId);
const findConv = vi.mocked(findMessengerConversation);
const appendMsg = vi.mocked(appendMessengerMessage);
const stampRef = vi.mocked(setMessengerConversationReferral);
const wabaConn = vi.mocked(getWhatsAppConnectionByWabaId);
const setTemplates = vi.mocked(updateWhatsAppTemplates);
const sysLog = vi.mocked(recordSystemLog);

const ECHO = {
  platform: "messenger" as const,
  accountId: "p1",
  recipientId: "psid-1",
  mid: "m-echo",
  text: "I can help with that",
  appId: META_PAGE_INBOX_APP_ID
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.META_APP_ID = OUR_APP;
  byPage.mockResolvedValue({ business_id: BIZ } as never);
  byIg.mockResolvedValue({ business_id: BIZ } as never);
  findConv.mockResolvedValue({ id: "conv-1" } as never);
  appendMsg.mockResolvedValue({ id: 9 } as never);
  stampRef.mockResolvedValue(true);
  wabaConn.mockResolvedValue({
    business_id: BIZ,
    templates: { nc_contact_followup: { status: "APPROVED", language: "en" } }
  } as never);
  setTemplates.mockResolvedValue(undefined as never);
  sysLog.mockResolvedValue(undefined);
});

describe("processMetaEchoEvent", () => {
  it("records a Page Inbox reply as an OWNER turn", async () => {
    // That single write is the whole fix: buildMessengerContents returns null
    // when a model-side row trails the last user turn, so the queued job
    // fails as no_input and the AI stays quiet.
    expect(await processMetaEchoEvent(ECHO)).toBe(true);
    expect(appendMsg).toHaveBeenCalledWith({
      conversationId: "conv-1",
      businessId: BIZ,
      role: "owner",
      content: "I can help with that",
      mid: "m-echo"
    });
  });

  it("DROPS our own reply coming home", async () => {
    // Recording ours as an owner turn would silence the AI right after it
    // spoke and stall the conversation.
    expect(await processMetaEchoEvent({ ...ECHO, appId: OUR_APP })).toBe(false);
    expect(appendMsg).not.toHaveBeenCalled();
    expect(findConv).not.toHaveBeenCalled();
  });

  it("treats a THIRD-PARTY app and an ABSENT app id as not-ours", async () => {
    // Erring toward "someone else is in the thread" costs one extra owner
    // turn; erring the other way means talking over staff.
    expect(await processMetaEchoEvent({ ...ECHO, appId: "999999" })).toBe(true);
    expect(await processMetaEchoEvent({ ...ECHO, appId: "" })).toBe(true);
  });

  it("resolves Instagram threads by IG account, not page id", async () => {
    await processMetaEchoEvent({ ...ECHO, platform: "instagram", accountId: "ig-1" });
    expect(byIg).toHaveBeenCalledWith("ig-1");
    expect(byPage).not.toHaveBeenCalled();
  });

  it("keeps an attachment-only reply readable rather than skipping it", async () => {
    // An empty echo still proves a human is present.
    await processMetaEchoEvent({ ...ECHO, text: "" });
    expect(appendMsg).toHaveBeenCalledWith(
      expect.objectContaining({ content: "[replied in Meta inbox]" })
    );
  });

  it("does nothing without a connection or a thread, and never throws", async () => {
    byPage.mockResolvedValue(null);
    expect(await processMetaEchoEvent(ECHO)).toBe(false);

    byPage.mockResolvedValue({ business_id: BIZ } as never);
    findConv.mockResolvedValue(null);
    expect(await processMetaEchoEvent(ECHO)).toBe(false);

    findConv.mockRejectedValue(new Error("db down"));
    expect(await processMetaEchoEvent(ECHO)).toBe(false);

    findConv.mockResolvedValue({ id: "conv-1" } as never);
    appendMsg.mockRejectedValue(new Error("db down"));
    expect(await processMetaEchoEvent(ECHO)).toBe(false);
    // A non-Error throw must not escape either.
    appendMsg.mockRejectedValue("db down, no Error");
    expect(await processMetaEchoEvent(ECHO)).toBe(false);
  });

  it("swallows a connection-lookup failure on both platforms", async () => {
    byPage.mockRejectedValue(new Error("db down"));
    expect(await processMetaEchoEvent(ECHO)).toBe(false);
    byIg.mockRejectedValue(new Error("db down"));
    expect(await processMetaEchoEvent({ ...ECHO, platform: "instagram" })).toBe(false);
  });

  it("never treats a WhatsApp thread as a Page echo", async () => {
    // WhatsApp has no Page Inbox and no echo field; there is nothing to
    // resolve, and resolving it as a Page would be wrong.
    expect(await processMetaEchoEvent({ ...ECHO, platform: "whatsapp" })).toBe(false);
    expect(byPage).not.toHaveBeenCalled();
    expect(byIg).not.toHaveBeenCalled();
  });

  it("treats a duplicate mid as our own echo already seen", async () => {
    // appendMessengerMessage returns null on the partial unique index, which
    // is a second line of defense behind the app_id check.
    appendMsg.mockResolvedValue(null);
    expect(await processMetaEchoEvent(ECHO)).toBe(false);
  });
});

const REFERRAL = {
  platform: "messenger" as const,
  accountId: "p1",
  senderId: "psid-1",
  ref: "SPRING_SALE",
  source: "ADS",
  type: "OPEN_THREAD",
  adId: "120200000000000",
  adTitle: "Spring roof special"
};

describe("processMetaEchoEvent: no app id configured", () => {
  it("treats every echo as foreign when META_APP_ID is unset", async () => {
    // A misconfigured env must not make the AI talk over staff; it errs the
    // safe way instead.
    delete process.env.META_APP_ID;
    expect(await processMetaEchoEvent({ ...ECHO, appId: OUR_APP })).toBe(true);
    process.env.META_APP_ID = OUR_APP;
  });
});

describe("processMetaReferralEvent", () => {
  it("stamps the attribution on the conversation", async () => {
    expect(await processMetaReferralEvent(REFERRAL)).toBe(true);
    expect(stampRef).toHaveBeenCalledWith("conv-1", {
      ref: "SPRING_SALE",
      source: "ADS",
      type: "OPEN_THREAD",
      ad_id: "120200000000000",
      ad_title: "Spring roof special"
    });
  });

  it("logs a ref-only referral without inventing an ad id", async () => {
    // Covers the log's null fallbacks: a flyer QR code has a ref and no ad.
    expect(await processMetaReferralEvent({ ...REFERRAL, adId: "", adTitle: "" })).toBe(true);
    expect(stampRef).toHaveBeenCalledWith("conv-1", expect.objectContaining({ ad_id: "" }));
    // And an ad-only referral with no ref code.
    expect(await processMetaReferralEvent({ ...REFERRAL, ref: "" })).toBe(true);
  });

  it("reports false when the thread already has attribution", async () => {
    // The referral that STARTED the conversation is the one worth reporting;
    // the setter is guarded so a later re-entry cannot overwrite it.
    stampRef.mockResolvedValue(false);
    expect(await processMetaReferralEvent(REFERRAL)).toBe(false);
  });

  it("ignores a referral carrying neither an ad nor a ref code", async () => {
    expect(await processMetaReferralEvent({ ...REFERRAL, adId: "", ref: "" })).toBe(false);
    expect(findConv).not.toHaveBeenCalled();
  });

  it("does nothing without a connection or a thread, and never throws", async () => {
    byPage.mockResolvedValue(null);
    expect(await processMetaReferralEvent(REFERRAL)).toBe(false);

    byPage.mockResolvedValue({ business_id: BIZ } as never);
    findConv.mockResolvedValue(null);
    expect(await processMetaReferralEvent(REFERRAL)).toBe(false);

    findConv.mockRejectedValue(new Error("db down"));
    expect(await processMetaReferralEvent(REFERRAL)).toBe(false);

    findConv.mockResolvedValue({ id: "conv-1" } as never);
    stampRef.mockRejectedValue(new Error("db down"));
    expect(await processMetaReferralEvent(REFERRAL)).toBe(false);
    stampRef.mockRejectedValue("db down, no Error");
    expect(await processMetaReferralEvent(REFERRAL)).toBe(false);
  });
});

const STATUS = {
  wabaId: "waba-1",
  templateName: "nc_contact_followup",
  language: "en",
  status: "PAUSED",
  reason: "PACING"
};

describe("processMetaTemplateStatusEvent", () => {
  it("writes the new status, which is what stops the sends", async () => {
    // deliverWhatsApp refuses an out-of-window send unless the STORED status
    // is APPROVED, so this write is the entire fix.
    expect(await processMetaTemplateStatusEvent(STATUS)).toBe(true);
    expect(setTemplates).toHaveBeenCalledWith(BIZ, {
      nc_contact_followup: { status: "PAUSED", language: "en" }
    });
  });

  it("tells the owner when an approved template goes bad", async () => {
    await processMetaTemplateStatusEvent(STATUS);
    expect(sysLog).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        event: "whatsapp_template_status_changed",
        level: "warn",
        message: expect.stringContaining("PAUSED")
      })
    );
  });

  it("omits the parenthetical when Meta sends no reason", async () => {
    await processMetaTemplateStatusEvent({ ...STATUS, reason: "" });
    const msg = (sysLog.mock.calls[0][0] as { message: string }).message;
    expect(msg).toContain("is now PAUSED.");
    expect(msg).not.toContain("()");
  });

  it("stays quiet when a template becomes APPROVED", async () => {
    // Good news needs no alert; the status write still happens.
    expect(await processMetaTemplateStatusEvent({ ...STATUS, status: "APPROVED" })).toBe(true);
    expect(setTemplates).toHaveBeenCalled();
    expect(sysLog).not.toHaveBeenCalled();
  });

  it("REFUSES to invent an entry for a template we never registered", async () => {
    // An unknown name is somebody else's template on the same WABA, and
    // adding it would make deliverWhatsApp consider sending it.
    expect(
      await processMetaTemplateStatusEvent({ ...STATUS, templateName: "not_ours" })
    ).toBe(false);
    expect(setTemplates).not.toHaveBeenCalled();
  });

  it("preserves the other templates and the entry's other fields", async () => {
    wabaConn.mockResolvedValue({
      business_id: BIZ,
      templates: {
        nc_contact_followup: { status: "APPROVED", language: "en", id: "t-1" },
        nc_owner_alert: { status: "APPROVED", language: "en" }
      }
    } as never);
    await processMetaTemplateStatusEvent(STATUS);
    expect(setTemplates).toHaveBeenCalledWith(BIZ, {
      nc_contact_followup: { status: "PAUSED", language: "en", id: "t-1" },
      nc_owner_alert: { status: "APPROVED", language: "en" }
    });
  });

  it("does nothing for an unconnected WABA, and tolerates no templates", async () => {
    wabaConn.mockResolvedValue(null);
    expect(await processMetaTemplateStatusEvent(STATUS)).toBe(false);

    // A lookup failure is swallowed the same way, not thrown at the webhook.
    wabaConn.mockRejectedValue(new Error("db down"));
    expect(await processMetaTemplateStatusEvent(STATUS)).toBe(false);

    wabaConn.mockResolvedValue({ business_id: BIZ, templates: null } as never);
    expect(await processMetaTemplateStatusEvent(STATUS)).toBe(false);
  });
});
