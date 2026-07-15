/**
 * Tests for the Messenger lead-capture core
 * (src/lib/messenger/lead-capture.ts): actionable-content gate,
 * conversation-ref validation (cross-tenant refs dropped), best-effort
 * merges, and the cross-channel contact rollup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const insertCoworkerLogMock = vi.fn();
vi.mock("@/lib/db/logs", () => ({
  insertCoworkerLog: (row: unknown) => insertCoworkerLogMock(row)
}));

const getConversationMock = vi.fn();
const updateContactMock = vi.fn();
vi.mock("@/lib/messenger/db", () => ({
  getMessengerConversationById: (id: string) => getConversationMock(id),
  updateMessengerConversationContact: (id: string, contact: unknown) =>
    updateContactMock(id, contact)
}));

const recordInteractionMock = vi.fn();
const linkEmailMock = vi.fn();
vi.mock("@/lib/customer-memory/db", () => ({
  recordInteractionAndIncrement: (
    businessId: string,
    e164: string,
    channel: string,
    opts: unknown
  ) => recordInteractionMock(businessId, e164, channel, opts),
  linkCustomerEmail: (businessId: string, e164: string, email: string) =>
    linkEmailMock(businessId, e164, email)
}));

vi.mock("@/lib/telnyx/assign-did", () => ({
  coerceOwnerPhoneToE164: (phone: string | null) =>
    phone && phone.replace(/\D/g, "").length >= 10
      ? `+1${phone.replace(/\D/g, "").slice(-10)}`
      : null
}));

import { captureMessengerLead } from "@/lib/messenger/lead-capture";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONV_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  insertCoworkerLogMock.mockReset().mockResolvedValue(undefined);
  getConversationMock.mockReset();
  updateContactMock.mockReset().mockResolvedValue(undefined);
  recordInteractionMock.mockReset().mockResolvedValue(undefined);
  linkEmailMock.mockReset().mockResolvedValue(undefined);
});

describe("captureMessengerLead", () => {
  it("rejects an empty capture", async () => {
    const res = await captureMessengerLead(BIZ, { name: "  ", notes: "" });
    expect(res).toEqual({ ok: false, detail: "empty_capture" });
    expect(insertCoworkerLogMock).not.toHaveBeenCalled();
  });

  it("logs the lead with validated conversation attribution and merges contact", async () => {
    getConversationMock.mockResolvedValue({ id: CONV_ID, business_id: BIZ });
    const res = await captureMessengerLead(BIZ, {
      name: "Jane Doe",
      phone: "555-123-4567",
      email: "jane@x.com",
      interest: "meta ads management",
      sessionRef: CONV_ID
    });
    expect(res.ok).toBe(true);

    const logged = insertCoworkerLogMock.mock.calls[0][0] as {
      task_type: string;
      log_payload: Record<string, unknown>;
    };
    expect(logged.task_type).toBe("messenger");
    expect(logged.log_payload.conversationId).toBe(CONV_ID);
    expect(updateContactMock).toHaveBeenCalledWith(CONV_ID, {
      name: "Jane Doe",
      phone: "555-123-4567"
    });
    expect(recordInteractionMock).toHaveBeenCalledWith(BIZ, "+15551234567", "messenger", {
      displayName: "Jane Doe"
    });
    expect(linkEmailMock).toHaveBeenCalledWith(BIZ, "+15551234567", "jane@x.com");
  });

  it("drops a cross-tenant conversation ref but still logs the lead", async () => {
    getConversationMock.mockResolvedValue({ id: CONV_ID, business_id: "other-biz" });
    const res = await captureMessengerLead(BIZ, { interest: "hello", sessionRef: CONV_ID });
    expect(res.ok).toBe(true);
    const logged = insertCoworkerLogMock.mock.calls[0][0] as {
      log_payload: Record<string, unknown>;
    };
    expect(logged.log_payload.conversationId).toBeNull();
    expect(updateContactMock).not.toHaveBeenCalled();
  });

  it("ignores malformed refs and survives a lookup failure", async () => {
    const res = await captureMessengerLead(BIZ, {
      interest: "x",
      sessionRef: "not-a-uuid"
    });
    expect(res.ok).toBe(true);
    expect(getConversationMock).not.toHaveBeenCalled();

    getConversationMock.mockRejectedValue(new Error("db down"));
    const res2 = await captureMessengerLead(BIZ, { interest: "x", sessionRef: CONV_ID });
    expect(res2.ok).toBe(true);

    getConversationMock.mockRejectedValue("plain string failure");
    const res3 = await captureMessengerLead(BIZ, { interest: "x", sessionRef: CONV_ID });
    expect(res3.ok).toBe(true);
  });

  it("degrades silently when merges and rollups fail (lead already logged)", async () => {
    getConversationMock.mockResolvedValue({ id: CONV_ID, business_id: BIZ });
    updateContactMock.mockRejectedValue(new Error("merge fail"));
    recordInteractionMock.mockRejectedValue("rollup string fail");
    linkEmailMock.mockRejectedValue(new Error("link fail"));

    const res = await captureMessengerLead(BIZ, {
      phone: "5551234567",
      email: "j@x.com",
      sessionRef: CONV_ID
    });
    expect(res.ok).toBe(true);

    // Error-shaped merge failures and non-Error rollup failures both log.
    updateContactMock.mockRejectedValue("merge string fail");
    recordInteractionMock.mockRejectedValue(new Error("rollup fail"));
    linkEmailMock.mockRejectedValue("link string fail");
    const res2 = await captureMessengerLead(BIZ, {
      phone: "5551234567",
      email: "j@x.com",
      sessionRef: CONV_ID
    });
    expect(res2.ok).toBe(true);
  });

  it("skips the rollup for uncoercible phones and the email link when absent", async () => {
    const res = await captureMessengerLead(BIZ, { name: "Jane", phone: "12" });
    expect(res.ok).toBe(true);
    expect(recordInteractionMock).not.toHaveBeenCalled();

    const res2 = await captureMessengerLead(BIZ, { phone: "5551234567" });
    expect(res2.ok).toBe(true);
    expect(recordInteractionMock).toHaveBeenCalled();
    expect(linkEmailMock).not.toHaveBeenCalled();
  });
});
