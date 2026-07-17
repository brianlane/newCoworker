/**
 * Tests for the central outbound WhatsApp delivery helper
 * (src/lib/whatsapp/deliver.ts): recipient coercion, connection gating,
 * the 24h-window free-form vs approved-template routing, template review
 * gating, transcript threading (including outbound-created conversations
 * with a CLOSED window), and best-effort append degradation.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock("@/lib/telnyx/assign-did", () => ({
  coerceOwnerPhoneToE164: (phone: string | null) =>
    phone && phone.replace(/\D/g, "").length >= 10
      ? `+1${phone.replace(/\D/g, "").slice(-10)}`
      : null
}));

import {
  deliverWhatsApp,
  toWaId,
  type DeliverWhatsAppDeps
} from "@/lib/whatsapp/deliver";
import type { WhatsAppConnectionRow } from "@/lib/db/whatsapp-connections";
import type { MessengerConversationRow } from "@/lib/messenger/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONV_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-16T18:00:00Z");

const CONNECTION: WhatsAppConnectionRow = {
  id: "wc-1",
  business_id: BIZ,
  waba_id: "waba-9",
  phone_number_id: "pn-9",
  display_phone_number: "+1 555-010-0000",
  accessToken: "business-token",
  templates: {
    nc_owner_alert: { status: "APPROVED", language: "en_US" },
    nc_contact_followup: { status: "APPROVED", language: "en_US" }
  },
  is_active: true,
  created_at: "2026-07-16T00:00:00Z",
  updated_at: "2026-07-16T00:00:00Z"
};

function conversation(
  overrides: Partial<MessengerConversationRow> = {}
): MessengerConversationRow {
  return {
    id: CONV_ID,
    business_id: BIZ,
    page_id: "pn-9",
    platform: "whatsapp",
    psid: "15551234567",
    display_name: "Jane",
    contact_phone: null,
    status: "active",
    last_user_message_at: "2026-07-16T17:00:00Z",
    created_at: "2026-07-16T00:00:00Z",
    updated_at: "2026-07-16T17:00:00Z",
    ...overrides
  };
}

function makeDeps(overrides: Partial<DeliverWhatsAppDeps> = {}): Required<
  Omit<DeliverWhatsAppDeps, "now">
> & { now: () => Date } {
  return {
    getConnection: vi.fn(async () => CONNECTION),
    getConversation: vi.fn(async () => conversation()),
    createConversation: vi.fn(async () => conversation()),
    appendMessage: vi.fn(async () => ({ id: 1 }) as never),
    sendText: vi.fn(async () => ({ messageId: "wamid-text" })),
    sendTemplate: vi.fn(async () => ({ messageId: "wamid-tmpl" })),
    fetchBusinessName: vi.fn(async () => "Acme Plumbing"),
    now: () => NOW,
    ...overrides
  };
}

const INPUT = {
  businessId: BIZ,
  to: "(555) 123-4567",
  text: "Following up on your quote.",
  audience: "contact" as const
};

describe("toWaId", () => {
  it("returns E.164 digits without the plus, null for garbage", () => {
    expect(toWaId("(555) 123-4567")).toBe("15551234567");
    expect(toWaId("12")).toBeNull();
    expect(toWaId("   ")).toBeNull();
  });

  it("accepts international digits with or without the plus (inbound wa_id round-trip)", () => {
    // Meta's stored psid is plus-less international digits — sending back
    // to it must work as-is.
    expect(toWaId("447911123456")).toBe("447911123456");
    expect(toWaId("+44 7911 123456")).toBe("447911123456");
    expect(toWaId("+15551234567")).toBe("15551234567");
    // E.164 never starts with 0; over-long runs are rejected.
    expect(toWaId("07911123456")).toBeNull();
    expect(toWaId("1234567890123456")).toBeNull();
  });
});

describe("deliverWhatsApp", () => {
  it("rejects uncoercible recipients and empty text", async () => {
    const deps = makeDeps();
    expect(await deliverWhatsApp({ ...INPUT, to: "12" }, deps)).toEqual({
      ok: false,
      reason: "invalid_recipient",
      detail: "12"
    });
    expect(await deliverWhatsApp({ ...INPUT, text: "   " }, deps)).toEqual({
      ok: false,
      reason: "empty_text"
    });
    expect(deps.getConnection).not.toHaveBeenCalled();
  });

  it("skips when WhatsApp is not connected, paused, or the read fails", async () => {
    const none = makeDeps({ getConnection: vi.fn(async () => null) });
    expect(await deliverWhatsApp(INPUT, none)).toEqual({ ok: false, reason: "not_connected" });

    const paused = makeDeps({
      getConnection: vi.fn(async () => ({ ...CONNECTION, is_active: false }))
    });
    expect(await deliverWhatsApp(INPUT, paused)).toEqual({
      ok: false,
      reason: "not_connected"
    });

    // Transient infra failures are RETRYABLE send failures, never a
    // misleading "not connected" (Bugbot round 8).
    const broken = makeDeps({
      getConnection: vi.fn(async () => {
        throw new Error("db down");
      })
    });
    expect(await deliverWhatsApp(INPUT, broken)).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "connection_read_failed"
    });

    const stringy = makeDeps({
      getConnection: vi.fn(async () => {
        throw "db string failure";
      })
    });
    expect(await deliverWhatsApp(INPUT, stringy)).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "connection_read_failed"
    });
  });

  it("sends free-form text inside the 24h window and threads the transcript", async () => {
    const deps = makeDeps();
    const result = await deliverWhatsApp(INPUT, deps);
    expect(result).toEqual({ ok: true, via: "text", messageId: "wamid-text" });
    expect(deps.sendText).toHaveBeenCalledWith(
      "pn-9",
      "business-token",
      "15551234567",
      "Following up on your quote."
    );
    expect(deps.sendTemplate).not.toHaveBeenCalled();
    // Existing conversation: no create, transcript row appended as 'owner'.
    expect(deps.createConversation).not.toHaveBeenCalled();
    expect(deps.appendMessage).toHaveBeenCalledWith({
      conversationId: CONV_ID,
      businessId: BIZ,
      role: "owner",
      content: "Following up on your quote."
    });
  });

  it("routes out-of-window sends through the audience template with rendered transcript copy", async () => {
    const deps = makeDeps({
      getConversation: vi.fn(async () =>
        conversation({ last_user_message_at: "2026-07-10T00:00:00Z" })
      )
    });
    const result = await deliverWhatsApp(INPUT, deps);
    expect(result).toEqual({ ok: true, via: "template", messageId: "wamid-tmpl" });
    expect(deps.sendText).not.toHaveBeenCalled();
    expect(deps.sendTemplate).toHaveBeenCalledWith("pn-9", "business-token", "15551234567", {
      name: "nc_contact_followup",
      language: "en_US",
      bodyParams: ["Acme Plumbing", "Following up on your quote."]
    });
    // The transcript stores what the recipient actually read.
    const appended = vi.mocked(deps.appendMessage).mock.calls[0][0];
    expect(appended.content).toContain("Acme Plumbing");
    expect(appended.content).toContain("Following up on your quote.");
  });

  it("does not interpret $ sequences in template transcript interpolation", async () => {
    const deps = makeDeps({
      fetchBusinessName: vi.fn(async () => "Tom & Jerry"),
      getConversation: vi.fn(async () =>
        conversation({ last_user_message_at: "2026-07-10T00:00:00Z" })
      )
    });
    await deliverWhatsApp({ ...INPUT, text: "Price is $& today" }, deps);
    const appended = vi.mocked(deps.appendMessage).mock.calls[0][0];
    expect(appended.content).toContain("Tom & Jerry");
    expect(appended.content).toContain("Price is $& today");
  });

  it("uses the owner-alert template for the owner audience (no conversation at all)", async () => {
    const deps = makeDeps({
      getConversation: vi.fn(async () => null)
    });
    const result = await deliverWhatsApp({ ...INPUT, audience: "owner" }, deps);
    expect(result).toMatchObject({ ok: true, via: "template" });
    expect(vi.mocked(deps.sendTemplate).mock.calls[0][3].name).toBe("nc_owner_alert");
    // No conversation existed: an outbound-created one threads the send.
    expect(deps.createConversation).toHaveBeenCalledWith({
      businessId: BIZ,
      pageId: "pn-9",
      platform: "whatsapp",
      psid: "15551234567"
    });
  });

  it("falls back to 'your business' when the name read fails and honors template language", async () => {
    const deps = makeDeps({
      getConversation: vi.fn(async () => null),
      fetchBusinessName: vi.fn(async () => null),
      getConnection: vi.fn(async () => ({
        ...CONNECTION,
        templates: {
          nc_contact_followup: { status: "APPROVED", language: "en_GB" }
        }
      }))
    });
    await deliverWhatsApp(INPUT, deps);
    const template = vi.mocked(deps.sendTemplate).mock.calls[0][3];
    expect(template.bodyParams[0]).toBe("your business");
    expect(template.language).toBe("en_GB");
  });

  it("skips out-of-window sends while the template is unapproved / unregistered", async () => {
    const pending = makeDeps({
      getConversation: vi.fn(async () => null),
      getConnection: vi.fn(async () => ({
        ...CONNECTION,
        templates: { nc_contact_followup: { status: "PENDING", language: "en_US" } }
      }))
    });
    expect(await deliverWhatsApp(INPUT, pending)).toEqual({
      ok: false,
      reason: "template_not_approved",
      detail: "nc_contact_followup: PENDING"
    });
    expect(pending.sendTemplate).not.toHaveBeenCalled();

    const missing = makeDeps({
      getConversation: vi.fn(async () => null),
      getConnection: vi.fn(async () => ({ ...CONNECTION, templates: {} }))
    });
    expect(await deliverWhatsApp(INPUT, missing)).toMatchObject({
      ok: false,
      reason: "template_not_approved",
      detail: "nc_contact_followup: not registered"
    });

    const nullTemplates = makeDeps({
      getConversation: vi.fn(async () => null),
      getConnection: vi.fn(async () => ({ ...CONNECTION, templates: null }))
    });
    expect(await deliverWhatsApp(INPUT, nullTemplates)).toMatchObject({
      ok: false,
      reason: "template_not_approved"
    });
  });

  it("reports send failures from both paths (Error and non-Error shapes)", async () => {
    const textFail = makeDeps({
      sendText: vi.fn(async () => {
        throw new Error("cloud api 500");
      })
    });
    expect(await deliverWhatsApp(INPUT, textFail)).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "cloud api 500"
    });
    expect(textFail.appendMessage).not.toHaveBeenCalled();

    const tmplFail = makeDeps({
      getConversation: vi.fn(async () => null),
      sendTemplate: vi.fn(async () => {
        throw "template string failure";
      })
    });
    expect(await deliverWhatsApp(INPUT, tmplFail)).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "template string failure"
    });
  });

  it("covers the alternate error shapes on both send paths and the language fallback", async () => {
    const textStringy = makeDeps({
      sendText: vi.fn(async () => {
        throw "text string failure";
      })
    });
    expect(await deliverWhatsApp(INPUT, textStringy)).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "text string failure"
    });

    const tmplError = makeDeps({
      getConversation: vi.fn(async () => null),
      sendTemplate: vi.fn(async () => {
        throw new Error("template 500");
      })
    });
    expect(await deliverWhatsApp(INPUT, tmplError)).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "template 500"
    });

    // A registered template with a blank language falls back to the stock one.
    const blankLang = makeDeps({
      getConversation: vi.fn(async () => null),
      getConnection: vi.fn(async () => ({
        ...CONNECTION,
        templates: { nc_contact_followup: { status: "APPROVED", language: "" } }
      }))
    });
    await deliverWhatsApp(INPUT, blankLang);
    expect(vi.mocked(blankLang.sendTemplate).mock.calls[0][3].language).toBe("en_US");
  });

  it("re-checks the window before committing to the template path (first-message race)", async () => {
    // First read: stale. Second read (right before the send): the
    // customer's first message just landed — the window is open, so the
    // send flips to free-form text instead of a billed template.
    const deps = makeDeps({
      getConversation: vi
        .fn()
        .mockResolvedValueOnce(conversation({ last_user_message_at: "2026-07-10T00:00:00Z" }))
        .mockResolvedValueOnce(conversation())
    });
    const result = await deliverWhatsApp(INPUT, deps);
    expect(result).toMatchObject({ ok: true, via: "text" });
    expect(deps.getConversation).toHaveBeenCalledTimes(2);
    expect(deps.sendTemplate).not.toHaveBeenCalled();
  });

  it("stores the sanitized template copy in the transcript (what the recipient actually read)", async () => {
    const deps = makeDeps({
      getConversation: vi.fn(async () => null),
      fetchBusinessName: vi.fn(async () => "Acme  \n Plumbing")
    });
    await deliverWhatsApp(
      { ...INPUT, text: "line one\nline two\t\ttabbed" },
      deps
    );
    const appended = vi.mocked(deps.appendMessage).mock.calls[0][0];
    expect(appended.content).toContain("Acme Plumbing");
    expect(appended.content).toContain("line one line two tabbed");
    expect(appended.content).not.toContain("\n");
  });

  it("fails retryable (never bills a template) when the window read keeps failing", async () => {
    const deps = makeDeps({
      getConversation: vi.fn(async () => {
        throw new Error("conv read down");
      })
    });
    expect(await deliverWhatsApp(INPUT, deps)).toEqual({
      ok: false,
      reason: "send_failed",
      detail: "conversation_read_failed"
    });
    expect(deps.sendTemplate).not.toHaveBeenCalled();
    expect(deps.sendText).not.toHaveBeenCalled();

    const stringy = makeDeps({
      getConversation: vi.fn(async () => {
        throw "conv read string failure";
      })
    });
    expect(await deliverWhatsApp(INPUT, stringy)).toMatchObject({
      ok: false,
      reason: "send_failed"
    });
  });

  it("retries a single failed window read and keeps the first good verdict on a failing re-read", async () => {
    // First read fails, retry succeeds with an open window → free text.
    const retried = makeDeps({
      getConversation: vi
        .fn()
        .mockRejectedValueOnce(new Error("blip"))
        .mockResolvedValueOnce(conversation())
    });
    expect(await deliverWhatsApp(INPUT, retried)).toMatchObject({ ok: true, via: "text" });

    // Good first read (closed window), failing race re-read: the first
    // verdict stands and the template path proceeds.
    const raceReadFails = makeDeps({
      getConversation: vi
        .fn()
        .mockResolvedValueOnce(conversation({ last_user_message_at: "2026-07-10T00:00:00Z" }))
        .mockRejectedValueOnce(new Error("blip"))
    });
    expect(await deliverWhatsApp(INPUT, raceReadFails)).toMatchObject({
      ok: true,
      via: "template"
    });
  });

  it("degrades silently when transcript threading fails (send already delivered)", async () => {
    const appendFail = makeDeps({
      appendMessage: vi.fn(async () => {
        throw new Error("append fail");
      })
    });
    expect(await deliverWhatsApp(INPUT, appendFail)).toMatchObject({ ok: true, via: "text" });

    const createFail = makeDeps({
      getConversation: vi.fn(async () => null),
      createConversation: vi.fn(async () => {
        throw "create string failure";
      })
    });
    expect(await deliverWhatsApp(INPUT, createFail)).toMatchObject({
      ok: true,
      via: "template"
    });

    // createConversation resolving null (identity race lost + re-read
    // missed) skips the append without failing the delivery.
    const createNull = makeDeps({
      getConversation: vi.fn(async () => null),
      createConversation: vi.fn(async () => null)
    });
    const result = await deliverWhatsApp(INPUT, createNull);
    expect(result).toMatchObject({ ok: true });
    expect(createNull.appendMessage).not.toHaveBeenCalled();
  });
});
