import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The route now calls the async per-tenant resolver. Keep the existing
// verifyRowboatWebhookJwt-driven tests working by delegating
// resolveRowboatWebhookClaims to the same mock fn.
const { verifyMock, resolveBusinessMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  // Default: identity (projectId == business_id, the >99% case).
  resolveBusinessMock: vi.fn(async (projectId: string) => projectId)
}));
vi.mock("@/lib/rowboat/webhook-jwt", () => ({
  verifyRowboatWebhookJwt: verifyMock,
  resolveRowboatWebhookClaims: vi.fn(async (token: string) => verifyMock(token))
}));

vi.mock("@/lib/db/vps-gateway-tokens", () => ({
  resolveBusinessIdForRowboatProject: resolveBusinessMock
}));

vi.mock("@/lib/db/agent-tool-settings", () => ({
  isAgentToolEnabled: vi.fn()
}));

vi.mock("@/lib/customer-tools/handlers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/customer-tools/handlers")>();
  return {
    E164_RE: actual.E164_RE,
    lookupCustomerByPhone: vi.fn(),
    setCustomerDisplayName: vi.fn(),
    appendCustomerPinnedNote: vi.fn()
  };
});

vi.mock("@/lib/telnyx/messaging", () => ({
  getTelnyxMessagingForBusiness: vi.fn(),
  sendTelnyxSms: vi.fn()
}));

vi.mock("@/lib/email/owner-mailbox", () => ({
  sendFromOwnerMailbox: vi.fn()
}));

vi.mock("@/lib/db/email-log", () => ({
  recordOutboundAssistantEmail: vi.fn()
}));

vi.mock("@/lib/knowledge-tools/handlers", () => ({
  lookupBusinessKnowledge: vi.fn()
}));

vi.mock("@/lib/calendar-tools/handlers", () => ({
  findCalendarSlots: vi.fn(),
  bookCalendarAppointment: vi.fn()
}));

import { POST } from "@/app/api/rowboat/tool-call/route";
import { verifyRowboatWebhookJwt } from "@/lib/rowboat/webhook-jwt";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import {
  appendCustomerPinnedNote,
  lookupCustomerByPhone,
  setCustomerDisplayName
} from "@/lib/customer-tools/handlers";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import { recordOutboundAssistantEmail } from "@/lib/db/email-log";
import { lookupBusinessKnowledge } from "@/lib/knowledge-tools/handlers";
import { findCalendarSlots, bookCalendarAppointment } from "@/lib/calendar-tools/handlers";

const BIZ = "11111111-1111-4111-8111-111111111111";

function makeContent(name: string, args: unknown): string {
  return JSON.stringify({
    toolCall: {
      id: "call-1",
      type: "function",
      function: { name, arguments: JSON.stringify(args) }
    }
  });
}

function makeRequest(content: string, requestId = "req-1"): Request {
  return new Request("http://localhost/api/rowboat/tool-call", {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature-jwt": "jwt" },
    body: JSON.stringify({ requestId, content })
  });
}

function claimsFor(content: string, overrides: Partial<Record<string, string>> = {}) {
  return {
    requestId: "req-1",
    projectId: BIZ,
    bodyHash: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAgentToolEnabled).mockResolvedValue(true);
  vi.mocked(getTelnyxMessagingForBusiness).mockResolvedValue({} as never);
  vi.mocked(sendTelnyxSms).mockResolvedValue({ id: "msg-1", channel: "sms" } as never);
});

describe("POST /api/rowboat/tool-call auth", () => {
  it("401s without a valid signature JWT", async () => {
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(null);
    const content = makeContent("customer_lookup_by_phone", { phone: "+15551230000" });
    const res = await POST(makeRequest(content));
    expect(res.status).toBe(401);
  });

  it("401s when bodyHash does not match the content", async () => {
    const content = makeContent("customer_lookup_by_phone", { phone: "+15551230000" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(
      claimsFor(content, { bodyHash: "0".repeat(64) })
    );
    const res = await POST(makeRequest(content));
    expect(res.status).toBe(401);
  });

  it("401s when the requestId does not match the signed claim", async () => {
    const content = makeContent("customer_lookup_by_phone", { phone: "+15551230000" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content, "different-request"));
    expect(res.status).toBe(401);
  });

  it("rejects a non-UUID projectId without dispatching", async () => {
    const content = makeContent("customer_lookup_by_phone", { phone: "+15551230000" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content, { projectId: "nope" }));
    const res = await POST(makeRequest(content));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "invalid_project" });
    expect(vi.mocked(lookupCustomerByPhone)).not.toHaveBeenCalled();
  });

  it("maps a re-pointed projectId to the OWNING business before gating/dispatching", async () => {
    const otherBiz = "22222222-2222-4222-8222-222222222222";
    resolveBusinessMock.mockResolvedValueOnce(otherBiz);
    const content = makeContent("customer_lookup_by_phone", { phone: "+15551230000" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    vi.mocked(lookupCustomerByPhone).mockResolvedValue({ found: false } as never);
    await POST(makeRequest(content));
    // The gate check and the handler must run against the resolved business, not
    // the raw projectId claim.
    expect(vi.mocked(isAgentToolEnabled)).toHaveBeenCalledWith(
      otherBiz,
      expect.anything(),
      expect.anything()
    );
    expect(vi.mocked(lookupCustomerByPhone)).toHaveBeenCalledWith(otherBiz, expect.anything());
  });

  it("rejects when the project→business resolution throws", async () => {
    resolveBusinessMock.mockRejectedValueOnce(new Error("db down"));
    const content = makeContent("customer_lookup_by_phone", { phone: "+15551230000" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect(await res.json()).toEqual({ ok: false, detail: "invalid_project" });
    expect(vi.mocked(lookupCustomerByPhone)).not.toHaveBeenCalled();
  });

  it("rejects when the resolved business id is not a UUID", async () => {
    resolveBusinessMock.mockResolvedValueOnce("not-a-uuid");
    const content = makeContent("customer_lookup_by_phone", { phone: "+15551230000" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect(await res.json()).toEqual({ ok: false, detail: "invalid_project" });
    expect(vi.mocked(lookupCustomerByPhone)).not.toHaveBeenCalled();
  });
});

describe("POST /api/rowboat/tool-call payload validation", () => {
  it("flags an invalid body shape", async () => {
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor("x"));
    const res = await POST(
      new Request("http://localhost/api/rowboat/tool-call", {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature-jwt": "jwt" },
        body: JSON.stringify({ nope: true })
      })
    );
    expect(await res.json()).toEqual({ ok: false, detail: "invalid_body" });
  });

  it("flags non-JSON content / malformed tool calls", async () => {
    const content = "not json";
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect(await res.json()).toEqual({ ok: false, detail: "invalid_tool_call" });
  });

  it("reports unknown tools without throwing", async () => {
    const content = makeContent("explode_database", {});
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect(await res.json()).toEqual({ ok: false, detail: "unknown_tool" });
  });
});

describe("POST /api/rowboat/tool-call enforcement", () => {
  it("returns tool_disabled when the owner turned the toggle off", async () => {
    vi.mocked(isAgentToolEnabled).mockResolvedValue(false);
    const content = makeContent("customer_append_pinned_note", {
      note: "allergic to nuts",
      phone: "+15551230000"
    });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.detail).toBe("tool_disabled");
    expect(vi.mocked(isAgentToolEnabled)).toHaveBeenCalledWith(
      BIZ,
      "sms",
      "customer_append_pinned_note"
    );
    expect(vi.mocked(appendCustomerPinnedNote)).not.toHaveBeenCalled();
  });

  it("gates send_sms on the dashboard toggle", async () => {
    vi.mocked(isAgentToolEnabled).mockResolvedValue(false);
    const content = makeContent("send_sms", { toE164: "+15551230000", body: "hi" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect((await res.json()).detail).toBe("tool_disabled");
    expect(vi.mocked(isAgentToolEnabled)).toHaveBeenCalledWith(BIZ, "dashboard", "send_sms");
    expect(vi.mocked(sendTelnyxSms)).not.toHaveBeenCalled();
  });
});

describe("POST /api/rowboat/tool-call dispatch", () => {
  it("dispatches customer_lookup_by_phone", async () => {
    vi.mocked(lookupCustomerByPhone).mockResolvedValue({
      ok: true,
      data: { found: true }
    });
    const content = makeContent("customer_lookup_by_phone", { phone: "+15551230000" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect(await res.json()).toEqual({ ok: true, data: { found: true } });
    expect(vi.mocked(lookupCustomerByPhone)).toHaveBeenCalledWith(BIZ, "+15551230000");
  });

  it("requires phone on this path (no caller context in the webhook payload)", async () => {
    const content = makeContent("customer_lookup_by_phone", {});
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.detail).toMatch(/^invalid_args:/);
    expect(vi.mocked(lookupCustomerByPhone)).not.toHaveBeenCalled();
  });

  it("dispatches customer_set_display_name with a trimmed name", async () => {
    vi.mocked(setCustomerDisplayName).mockResolvedValue({ ok: true, data: { updated: true } });
    const content = makeContent("customer_set_display_name", {
      displayName: "  Joe Plumber  ",
      phone: "+15551230000"
    });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect(await res.json()).toEqual({ ok: true, data: { updated: true } });
    expect(vi.mocked(setCustomerDisplayName)).toHaveBeenCalledWith(
      BIZ,
      "+15551230000",
      "Joe Plumber",
      "sms"
    );
  });

  it("rejects a whitespace-only displayName", async () => {
    const content = makeContent("customer_set_display_name", {
      displayName: "   ",
      phone: "+15551230000"
    });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect((await res.json()).detail).toBe("invalid_args:displayName empty");
  });

  it("dispatches customer_append_pinned_note with the text channel + stamp", async () => {
    vi.mocked(appendCustomerPinnedNote).mockResolvedValue({
      ok: true,
      data: { appended: true, pinnedChars: 30, truncated: false }
    });
    const content = makeContent("customer_append_pinned_note", {
      note: " prefers mornings ",
      phone: "+15551230000"
    });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect((await res.json()).ok).toBe(true);
    expect(vi.mocked(appendCustomerPinnedNote)).toHaveBeenCalledWith(
      BIZ,
      "+15551230000",
      "prefers mornings",
      "sms",
      "text"
    );
  });

  it("attributes the dashboard_ twins to the dashboard surface (toggle + channel)", async () => {
    vi.mocked(setCustomerDisplayName).mockResolvedValue({ ok: true, data: { updated: true } });
    vi.mocked(appendCustomerPinnedNote).mockResolvedValue({
      ok: true,
      data: { appended: true, pinnedChars: 10, truncated: false }
    });
    vi.mocked(lookupCustomerByPhone).mockResolvedValue({ ok: true, data: { found: false } });

    for (const [name, args] of [
      ["dashboard_customer_lookup_by_phone", { phone: "+15551230000" }],
      ["dashboard_customer_set_display_name", { displayName: "Joe", phone: "+15551230000" }],
      ["dashboard_customer_append_pinned_note", { note: "vip", phone: "+15551230000" }]
    ] as const) {
      const content = makeContent(name, args);
      vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
      const res = await POST(makeRequest(content));
      expect((await res.json()).ok).toBe(true);
      // Gated by the DASHBOARD toggle of the underlying tool key.
      expect(vi.mocked(isAgentToolEnabled)).toHaveBeenLastCalledWith(
        BIZ,
        "dashboard",
        name.replace(/^dashboard_/, "")
      );
    }
    // Writes record the honest dashboard channel, not "sms".
    expect(vi.mocked(setCustomerDisplayName)).toHaveBeenCalledWith(
      BIZ,
      "+15551230000",
      "Joe",
      "dashboard"
    );
    expect(vi.mocked(appendCustomerPinnedNote)).toHaveBeenCalledWith(
      BIZ,
      "+15551230000",
      "vip",
      "dashboard",
      "dashboard"
    );
  });

  it("rejects a whitespace-only note", async () => {
    const content = makeContent("customer_append_pinned_note", {
      note: "  ",
      phone: "+15551230000"
    });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect((await res.json()).detail).toBe("invalid_args:note empty");
  });

  it("sends an SMS through the metered Telnyx helper", async () => {
    const content = makeContent("send_sms", { toE164: "+15551230000", body: "On my way" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect(await res.json()).toEqual({
      ok: true,
      data: { messageId: "msg-1", toE164: "+15551230000" }
    });
    expect(vi.mocked(sendTelnyxSms)).toHaveBeenCalledWith(expect.anything(), "+15551230000", "On my way", {
      meterBusinessId: BIZ
    });
  });

  it("maps quota failures to sms_quota_blocked", async () => {
    vi.mocked(sendTelnyxSms).mockRejectedValue(new Error("Monthly SMS limit reached"));
    const content = makeContent("send_sms", { toE164: "+15551230000", body: "hi" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect((await res.json()).detail).toBe("sms_quota_blocked");
  });

  it("maps other send failures to sms_send_failed", async () => {
    vi.mocked(sendTelnyxSms).mockRejectedValue(new Error("telnyx 500"));
    const content = makeContent("send_sms", { toE164: "+15551230000", body: "hi" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect((await res.json()).detail).toBe("sms_send_failed");
  });

  it("rejects invalid send_sms args", async () => {
    const content = makeContent("send_sms", { toE164: "5551230000", body: "hi" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect((await res.json()).detail).toMatch(/^invalid_args:/);
    expect(vi.mocked(sendTelnyxSms)).not.toHaveBeenCalled();
  });

  it("dispatches business_knowledge_lookup on the sms toggle", async () => {
    vi.mocked(lookupBusinessKnowledge).mockResolvedValue({
      ok: true,
      data: { answer: "Open 9-5 weekdays." }
    });
    const content = makeContent("business_knowledge_lookup", { question: "What are your hours?" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect(await res.json()).toEqual({ ok: true, data: { answer: "Open 9-5 weekdays." } });
    expect(vi.mocked(isAgentToolEnabled)).toHaveBeenCalledWith(
      BIZ,
      "sms",
      "business_knowledge_lookup"
    );
    expect(vi.mocked(lookupBusinessKnowledge)).toHaveBeenCalledWith(BIZ, "What are your hours?");
  });

  it("rejects invalid business_knowledge_lookup args", async () => {
    const content = makeContent("business_knowledge_lookup", {});
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect((await res.json()).detail).toMatch(/^invalid_args:/);
    expect(vi.mocked(lookupBusinessKnowledge)).not.toHaveBeenCalled();
  });

  it("dispatches calendar_find_slots with a defaulted duration", async () => {
    vi.mocked(findCalendarSlots).mockResolvedValue({ ok: true, data: { slots: [] } });
    const content = makeContent("calendar_find_slots", { purpose: "estimate" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect((await res.json()).ok).toBe(true);
    expect(vi.mocked(findCalendarSlots)).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ purpose: "estimate", durationMinutes: 30 })
    );
  });

  it("rejects invalid calendar_find_slots args", async () => {
    const content = makeContent("calendar_find_slots", { durationMinutes: 2 });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect((await res.json()).detail).toMatch(/^invalid_args:/);
    expect(vi.mocked(findCalendarSlots)).not.toHaveBeenCalled();
  });

  it("dispatches calendar_book_appointment with no caller-phone fallback", async () => {
    vi.mocked(bookCalendarAppointment).mockResolvedValue({
      ok: true,
      data: { eventId: "ev-1", htmlLink: null, provider: "google" }
    });
    const args = {
      startIso: "2026-06-12T17:00:00.000Z",
      endIso: "2026-06-12T17:30:00.000Z",
      summary: "Estimate",
      attendeeName: "Joe Plumber"
    };
    const content = makeContent("calendar_book_appointment", args);
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect((await res.json()).ok).toBe(true);
    expect(vi.mocked(bookCalendarAppointment)).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining(args),
      null
    );
  });

  it("rejects invalid calendar_book_appointment args", async () => {
    const content = makeContent("calendar_book_appointment", { summary: "Estimate" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect((await res.json()).detail).toMatch(/^invalid_args:/);
    expect(vi.mocked(bookCalendarAppointment)).not.toHaveBeenCalled();
  });

  it("accepts offset-carrying ISO instants for calendar_book_appointment", async () => {
    // The tool contract instructs the model to send "ISO 8601 with timezone
    // offset" — rejecting offsets made every booking attempt fail (Truly's
    // Junaid conversation). Offsets must validate.
    vi.mocked(bookCalendarAppointment).mockResolvedValue({
      ok: true,
      data: { eventId: "ev-2", htmlLink: null, provider: "microsoft" }
    });
    const args = {
      startIso: "2026-06-12T13:00:00-04:00",
      endIso: "2026-06-12T13:30:00-04:00",
      summary: "Quote call",
      attendeeName: "Junaid Awan",
      timezone: "America/Toronto"
    };
    const content = makeContent("calendar_book_appointment", args);
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect((await res.json()).ok).toBe(true);
    expect(vi.mocked(bookCalendarAppointment)).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining(args),
      null
    );
  });

  it("sends email through the owner mailbox on the sms toggle", async () => {
    vi.mocked(sendFromOwnerMailbox).mockResolvedValue({
      ok: true,
      messageId: "m-1",
      provider: "google"
    } as never);
    const content = makeContent("send_email", {
      toEmail: "joe@example.com",
      subject: "Your estimate",
      bodyText: "Here are the details we discussed."
    });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect(await res.json()).toEqual({
      ok: true,
      data: { messageId: "m-1", provider: "google" }
    });
    expect(vi.mocked(isAgentToolEnabled)).toHaveBeenCalledWith(BIZ, "sms", "send_email");
    expect(vi.mocked(sendFromOwnerMailbox)).toHaveBeenCalledWith(BIZ, {
      toEmail: "joe@example.com",
      subject: "Your estimate",
      bodyText: "Here are the details we discussed.",
      ccEmails: [],
      bccEmails: []
    });
    expect(vi.mocked(recordOutboundAssistantEmail)).toHaveBeenCalledWith({
      businessId: BIZ,
      toEmail: "joe@example.com",
      subject: "Your estimate",
      bodyText: "Here are the details we discussed.",
      source: "sms_assistant",
      providerMessageId: "m-1",
      ccEmails: [],
      bccEmails: []
    });
  });

  it("forwards normalized cc/bcc on the sms send_email path", async () => {
    vi.mocked(sendFromOwnerMailbox).mockResolvedValue({
      ok: true,
      messageId: "m-2",
      provider: "google"
    } as never);
    const content = makeContent("send_email", {
      toEmail: "joe@example.com",
      subject: "Your estimate",
      bodyText: "Details.",
      cc: ["CC@x.com", "not-an-email"],
      bcc: "bcc@x.com"
    });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    await POST(makeRequest(content));
    expect(vi.mocked(sendFromOwnerMailbox)).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ ccEmails: ["cc@x.com"], bccEmails: ["bcc@x.com"] })
    );
  });

  it("propagates owner-mailbox failure details (e.g. email_not_connected)", async () => {
    vi.mocked(sendFromOwnerMailbox).mockResolvedValue({
      ok: false,
      detail: "email_not_connected"
    } as never);
    const content = makeContent("send_email", {
      toEmail: "joe@example.com",
      subject: "Hi",
      bodyText: "Body"
    });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect(await res.json()).toEqual({ ok: false, detail: "email_not_connected" });
    expect(vi.mocked(recordOutboundAssistantEmail)).not.toHaveBeenCalled();
  });

  it("rejects invalid send_email args", async () => {
    const content = makeContent("send_email", { toEmail: "not-an-email", subject: "s", bodyText: "b" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect((await res.json()).detail).toMatch(/^invalid_args:/);
    expect(vi.mocked(sendFromOwnerMailbox)).not.toHaveBeenCalled();
  });

  it("gates the dashboard_ knowledge/calendar twins on dashboard toggles", async () => {
    vi.mocked(lookupBusinessKnowledge).mockResolvedValue({ ok: true, data: { answer: "a" } });
    vi.mocked(findCalendarSlots).mockResolvedValue({ ok: true, data: { slots: [] } });
    vi.mocked(bookCalendarAppointment).mockResolvedValue({ ok: true, data: { eventId: "e" } });

    for (const [name, args, toolKey] of [
      ["dashboard_business_knowledge_lookup", { question: "hours?" }, "business_knowledge_lookup"],
      ["dashboard_calendar_find_slots", {}, "calendar_find_slots"],
      [
        "dashboard_calendar_book_appointment",
        {
          startIso: "2026-06-12T17:00:00.000Z",
          endIso: "2026-06-12T17:30:00.000Z",
          summary: "Estimate",
          attendeeName: "Joe"
        },
        "calendar_book_appointment"
      ]
    ] as const) {
      const content = makeContent(name, args);
      vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
      const res = await POST(makeRequest(content));
      expect((await res.json()).ok, name).toBe(true);
      expect(vi.mocked(isAgentToolEnabled)).toHaveBeenLastCalledWith(BIZ, "dashboard", toolKey);
    }
  });

  it("returns internal_error (HTTP 200) when a handler throws", async () => {
    vi.mocked(lookupCustomerByPhone).mockRejectedValue(new Error("db down"));
    const content = makeContent("customer_lookup_by_phone", { phone: "+15551230000" });
    vi.mocked(verifyRowboatWebhookJwt).mockReturnValue(claimsFor(content));
    const res = await POST(makeRequest(content));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "internal_error" });
  });
});
