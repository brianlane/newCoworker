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
vi.mock("@/lib/messenger/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messenger/db")>()),
  appendMessengerMessage: vi.fn(),
  applyMessengerDeliveryStatus: vi.fn(),
  findMessengerConversation: vi.fn(),
  setMessengerConversationReferral: vi.fn()
}));
vi.mock("@/lib/db/whatsapp-connections", () => ({
  getActiveWhatsAppConnectionByPhoneNumberId: vi.fn(),
  listActiveWhatsAppConnectionsByWabaId: vi.fn(),
  updateWhatsAppTemplates: vi.fn()
}));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));
vi.mock("@/lib/db/notifications", () => ({ markWhatsAppAlertUndelivered: vi.fn() }));

import {
  processMetaEchoEvent,
  processMetaMessageStatusEvent,
  processMetaReferralEvent,
  processMetaTemplateStatusEvent
} from "@/lib/meta/webhook-extras";
import {
  getActiveMetaConnectionByInstagramId,
  getActiveMetaConnectionByPageId
} from "@/lib/db/meta-connections";
import {
  appendMessengerMessage,
  applyMessengerDeliveryStatus,
  findMessengerConversation,
  setMessengerConversationReferral
} from "@/lib/messenger/db";
import {
  getActiveWhatsAppConnectionByPhoneNumberId,
  listActiveWhatsAppConnectionsByWabaId,
  updateWhatsAppTemplates
} from "@/lib/db/whatsapp-connections";
import { recordSystemLog } from "@/lib/db/system-logs";
import { markWhatsAppAlertUndelivered } from "@/lib/db/notifications";
import { META_PAGE_INBOX_APP_ID } from "@/lib/meta/client";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OUR_APP = "1554839372962421";

const byPage = vi.mocked(getActiveMetaConnectionByPageId);
const byIg = vi.mocked(getActiveMetaConnectionByInstagramId);
const findConv = vi.mocked(findMessengerConversation);
const appendMsg = vi.mocked(appendMessengerMessage);
const stampRef = vi.mocked(setMessengerConversationReferral);
const wabaConns = vi.mocked(listActiveWhatsAppConnectionsByWabaId);
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
  wabaConns.mockResolvedValue([
    {
      business_id: BIZ,
      templates: { nc_contact_followup: { status: "APPROVED", language: "en_US" } }
    }
  ] as never);
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
      nc_contact_followup: { status: "PAUSED", language: "en_US", lastEvent: "PAUSED" }
    });
  });

  it("keeps a SENDABLE event sendable instead of blocking it", async () => {
    // Meta emits REINSTATED, not APPROVED, when a paused template becomes
    // usable again. FLAGGED means at-risk-but-sendable and LOCKED means
    // cannot-be-edited. Writing any of them verbatim would leave
    // deliverWhatsApp refusing a template that works, until a manual
    // reconnect refreshed it from Graph.
    for (const event of ["APPROVED", "REINSTATED", "FLAGGED", "LOCKED"]) {
      setTemplates.mockClear();
      expect(await processMetaTemplateStatusEvent({ ...STATUS, status: event })).toBe(true);
      expect(setTemplates).toHaveBeenCalledWith(BIZ, {
        nc_contact_followup: { status: "APPROVED", language: "en_US", lastEvent: event }
      });
    }
  });

  it("blocks every event that genuinely stops sends", async () => {
    for (const event of [
      "PAUSED",
      "REJECTED",
      "DISABLED",
      "PENDING",
      "IN_APPEAL",
      "ARCHIVED",
      "DELETED",
      "PENDING_DELETION",
      "LIMIT_EXCEEDED"
    ]) {
      setTemplates.mockClear();
      await processMetaTemplateStatusEvent({ ...STATUS, status: event });
      const written = setTemplates.mock.calls[0][1] as Record<string, { status: string }>;
      expect(written.nc_contact_followup.status).toBe(event);
    }
  });

  it("keeps Meta's raw event alongside, so FLAGGED is not silently hidden", async () => {
    await processMetaTemplateStatusEvent({ ...STATUS, status: "FLAGGED" });
    const written = setTemplates.mock.calls[0][1] as Record<string, { lastEvent: string }>;
    expect(written.nc_contact_followup.lastEvent).toBe("FLAGGED");
  });

  it("targets the LANGUAGE-KEYED entry, not the bare name", async () => {
    // Stored state keys en_US bare and other languages with a suffix. Keying
    // a Spanish update by the bare name would paused-flag the English variant
    // and leave the Spanish one being sent.
    wabaConns.mockResolvedValue([
      {
        business_id: BIZ,
        templates: {
          nc_contact_followup: { status: "APPROVED", language: "en_US" },
          "nc_contact_followup:es": { status: "APPROVED", language: "es" }
        }
      }
    ] as never);
    await processMetaTemplateStatusEvent({ ...STATUS, language: "es" });
    expect(setTemplates).toHaveBeenCalledWith(BIZ, {
      nc_contact_followup: { status: "APPROVED", language: "en_US" },
      "nc_contact_followup:es": { status: "PAUSED", language: "es", lastEvent: "PAUSED" }
    });
  });

  it("normalizes every English code Meta sends onto the en_US key", async () => {
    // The webhook sends en-US or plain en; we key English as en_US. Without
    // normalizing, an English update would create a phantom key nothing reads.
    for (const language of ["en", "en-US", "en_US", ""]) {
      setTemplates.mockClear();
      await processMetaTemplateStatusEvent({ ...STATUS, language });
      const written = setTemplates.mock.calls[0][1] as Record<string, unknown>;
      expect(Object.keys(written)).toEqual(["nc_contact_followup"]);
    }
  });

  it("normalizes a regional Spanish code onto the es key", async () => {
    wabaConns.mockResolvedValue([
      {
        business_id: BIZ,
        templates: { "nc_contact_followup:es": { status: "APPROVED", language: "es" } }
      }
    ] as never);
    await processMetaTemplateStatusEvent({ ...STATUS, language: "es_MX" });
    const written = setTemplates.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(["nc_contact_followup:es"]);
  });

  it("applies to EVERY tenant on a shared WABA", async () => {
    // A singular lookup would have errored on a shared WABA and dropped the
    // update for all of them.
    wabaConns.mockResolvedValue([
      { business_id: BIZ, templates: { nc_contact_followup: { status: "APPROVED", language: "en_US" } } },
      { business_id: "biz-2", templates: { nc_contact_followup: { status: "APPROVED", language: "en_US" } } }
    ] as never);
    expect(await processMetaTemplateStatusEvent(STATUS)).toBe(true);
    expect(setTemplates).toHaveBeenCalledTimes(2);
    expect(sysLog).toHaveBeenCalledTimes(2);
  });

  it("keeps going when one tenant's write fails", async () => {
    wabaConns.mockResolvedValue([
      { business_id: BIZ, templates: { nc_contact_followup: { status: "APPROVED", language: "en_US" } } },
      { business_id: "biz-2", templates: { nc_contact_followup: { status: "APPROVED", language: "en_US" } } }
    ] as never);
    setTemplates.mockRejectedValueOnce(new Error("db down"));
    setTemplates.mockResolvedValueOnce(undefined as never);
    expect(await processMetaTemplateStatusEvent(STATUS)).toBe(true);
    // Only the tenant that succeeded gets the owner-facing log.
    expect(sysLog).toHaveBeenCalledTimes(1);

    setTemplates.mockRejectedValue("db down, no Error");
    expect(await processMetaTemplateStatusEvent(STATUS)).toBe(false);
  });

  it("tells the owner when a template stops being sendable", async () => {
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

  it("stays quiet for an event that keeps the template sendable", async () => {
    expect(await processMetaTemplateStatusEvent({ ...STATUS, status: "REINSTATED" })).toBe(true);
    expect(setTemplates).toHaveBeenCalled();
    expect(sysLog).not.toHaveBeenCalled();
  });

  it("REFUSES to invent an entry for a template we never registered", async () => {
    // An unknown key is somebody else's template on the same WABA, and adding
    // it would make deliverWhatsApp consider sending it.
    expect(
      await processMetaTemplateStatusEvent({ ...STATUS, templateName: "not_ours" })
    ).toBe(false);
    expect(setTemplates).not.toHaveBeenCalled();
  });

  it("preserves the other templates and the entry's other fields", async () => {
    wabaConns.mockResolvedValue([
      {
        business_id: BIZ,
        templates: {
          nc_contact_followup: { status: "APPROVED", language: "en_US", id: "t-1" },
          nc_owner_alert: { status: "APPROVED", language: "en_US" }
        }
      }
    ] as never);
    await processMetaTemplateStatusEvent(STATUS);
    expect(setTemplates).toHaveBeenCalledWith(BIZ, {
      nc_contact_followup: { status: "PAUSED", language: "en_US", id: "t-1", lastEvent: "PAUSED" },
      nc_owner_alert: { status: "APPROVED", language: "en_US" }
    });
  });

  it("does nothing for an unconnected WABA, tolerates no templates, never throws", async () => {
    wabaConns.mockResolvedValue([]);
    expect(await processMetaTemplateStatusEvent(STATUS)).toBe(false);

    wabaConns.mockRejectedValue(new Error("db down"));
    expect(await processMetaTemplateStatusEvent(STATUS)).toBe(false);

    wabaConns.mockResolvedValue([{ business_id: BIZ, templates: null }] as never);
    expect(await processMetaTemplateStatusEvent(STATUS)).toBe(false);
  });
});

describe("processMetaMessageStatusEvent", () => {
  const byNumber = vi.mocked(getActiveWhatsAppConnectionByPhoneNumberId);
  const apply = vi.mocked(applyMessengerDeliveryStatus);
  const event = (over: Partial<Parameters<typeof processMetaMessageStatusEvent>[0]> = {}) => ({
    accountId: "pn-1",
    mid: "wamid.ABC",
    status: "delivered",
    errorCode: null,
    errorTitle: null,
    occurredAt: "2026-08-25T06:46:59.000Z",
    ...over
  });

  const reconcile = vi.mocked(markWhatsAppAlertUndelivered);

  beforeEach(() => {
    byNumber.mockReset();
    apply.mockReset();
    reconcile.mockReset();
    vi.mocked(recordSystemLog).mockReset();
    byNumber.mockResolvedValue({ business_id: BIZ } as never);
    apply.mockResolvedValue("applied");
    reconcile.mockResolvedValue(false);
  });

  it("records a receipt against the message the wamid names", async () => {
    expect(await processMetaMessageStatusEvent(event())).toBe(true);
    expect(apply).toHaveBeenCalledWith({
      businessId: BIZ,
      mid: "wamid.ABC",
      status: "delivered",
      errorCode: null,
      errorTitle: null,
      timestamp: "2026-08-25T06:46:59.000Z"
    });
    // Routine receipts stay quiet: only a failure is owner-visible.
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("escalates a FAILED receipt to an owner-visible system log", async () => {
    const ok = await processMetaMessageStatusEvent(
      event({ status: "failed", errorCode: "131049", errorTitle: "Not delivered" })
    );
    expect(ok).toBe(true);
    const logged = vi.mocked(recordSystemLog).mock.calls[0][0];
    expect(logged.level).toBe("error");
    expect(logged.event).toBe("whatsapp_message_failed");
    // The error code is the only thing that explains a silent drop, so it
    // has to survive into the message a human reads.
    expect(logged.message).toContain("131049");
    expect(logged.message).toContain("Not delivered");
  });

  it("normalizes case and ignores a status the column cannot hold", async () => {
    expect(await processMetaMessageStatusEvent(event({ status: "READ" }))).toBe(true);
    expect(apply.mock.calls[0][0].status).toBe("read");
    // Meta adds states over time; an unmodelled one is not an error, and it
    // must not reach the DB where a check constraint would reject it.
    apply.mockClear();
    expect(await processMetaMessageStatusEvent(event({ status: "deleted" }))).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("reports nothing for a stale, unknown, or unconnected receipt", async () => {
    // A receipt for a message we never wrote (a human replying from the Meta
    // inbox) and an out-of-order one are both routine, not failures.
    apply.mockResolvedValue("not_found");
    expect(await processMetaMessageStatusEvent(event())).toBe(false);
    apply.mockResolvedValue("stale");
    expect(await processMetaMessageStatusEvent(event())).toBe(false);
    expect(recordSystemLog).not.toHaveBeenCalled();

    byNumber.mockResolvedValue(null);
    expect(await processMetaMessageStatusEvent(event())).toBe(false);
  });

  it("survives a connection lookup or write that throws", async () => {
    byNumber.mockRejectedValue(new Error("db down"));
    expect(await processMetaMessageStatusEvent(event())).toBe(false);

    byNumber.mockResolvedValue({ business_id: BIZ } as never);
    apply.mockRejectedValue(new Error("update failed"));
    expect(await processMetaMessageStatusEvent(event())).toBe(false);

    // A non-Error rejection must not itself throw while being logged.
    apply.mockRejectedValue("plain string");
    expect(await processMetaMessageStatusEvent(event())).toBe(false);
  });

  it("still reports a failure Meta declined to explain", async () => {
    // Meta does not always attach errors[]. The alert has to stand on its
    // own rather than rendering a dangling colon or an empty code.
    const ok = await processMetaMessageStatusEvent(
      event({ status: "failed", errorCode: null, errorTitle: null })
    );
    expect(ok).toBe(true);
    const logged = vi.mocked(recordSystemLog).mock.calls[0][0];
    expect(logged.message).toBe("WhatsApp did not deliver a message");
  });

  /**
   * The dispatcher records `sent` on Meta's ACCEPTANCE, and this receipt is
   * what disproves it. KYP Ads accumulated twenty WhatsApp alert rows marked
   * `sent` that Meta had dropped on billing error 131042, because nothing
   * ever came back to correct them.
   */
  it("corrects the alert row the dropped message belonged to", async () => {
    reconcile.mockResolvedValue(true);
    await processMetaMessageStatusEvent(
      event({
        status: "failed",
        errorCode: "131042",
        errorTitle: "Business eligibility payment issue"
      })
    );
    expect(reconcile).toHaveBeenCalledWith(
      BIZ,
      "wamid.ABC",
      "whatsapp_131042:Business eligibility payment issue"
    );
    // Said out loud on the log row: an operator reading it needs to know
    // whether an owner ALERT was lost or ordinary conversation traffic.
    expect(vi.mocked(recordSystemLog).mock.calls[0][0].payload?.alertRowReconciled).toBe(true);
  });

  it("names the failure even when Meta sends no code or title", async () => {
    await processMetaMessageStatusEvent(
      event({ status: "failed", errorCode: null, errorTitle: null })
    );
    expect(reconcile).toHaveBeenCalledWith(BIZ, "wamid.ABC", "whatsapp_delivery_failed");
  });

  it("reports no correction for conversation traffic, which has no alert row", async () => {
    // The common case by volume: a dropped reply to a lead. Not a fault, and
    // the log must not imply an alert was lost.
    reconcile.mockResolvedValue(false);
    expect(await processMetaMessageStatusEvent(event({ status: "failed" }))).toBe(true);
    expect(vi.mocked(recordSystemLog).mock.calls[0][0].payload?.alertRowReconciled).toBe(false);
  });

  it("still raises the alarm when the correction itself fails", async () => {
    // The system log is the louder signal. Losing the bookkeeping must never
    // also lose the alert, which is the whole failure this receipt reports.
    reconcile.mockRejectedValue(new Error("db down"));
    expect(await processMetaMessageStatusEvent(event({ status: "failed" }))).toBe(true);
    const logged = vi.mocked(recordSystemLog).mock.calls[0][0];
    expect(logged.event).toBe("whatsapp_message_failed");
    expect(logged.payload?.alertRowReconciled).toBe(false);

    // A non-Error rejection must not itself throw while being logged.
    vi.mocked(recordSystemLog).mockClear();
    reconcile.mockRejectedValue("plain string");
    expect(await processMetaMessageStatusEvent(event({ status: "failed" }))).toBe(true);
    expect(vi.mocked(recordSystemLog).mock.calls[0][0].event).toBe("whatsapp_message_failed");
  });

  it("does not touch alert rows for a receipt that is not a failure", async () => {
    await processMetaMessageStatusEvent(event({ status: "delivered" }));
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("never masks a failure with a receipt that was already in flight", async () => {
    // A `failed` send can still have a `sent` receipt behind it. The column
    // keeps the failure, so the failure must outrank it.
    apply.mockResolvedValue("stale");
    expect(await processMetaMessageStatusEvent(event({ status: "sent" }))).toBe(false);
    expect(recordSystemLog).not.toHaveBeenCalled();
  });
});
