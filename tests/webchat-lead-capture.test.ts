import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/logs", () => ({ insertCoworkerLog: vi.fn() }));
vi.mock("@/lib/webchat/db", () => ({
  getWebchatSessionById: vi.fn(),
  updateWebchatSessionContact: vi.fn()
}));
vi.mock("@/lib/customer-memory/db", () => ({
  linkCustomerEmail: vi.fn(),
  recordInteractionAndIncrement: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}));

import {
  captureWebchatLead,
  WEBCHAT_CAPTURE_NO_CONTACT_MESSAGE
} from "@/lib/webchat/lead-capture";
import { insertCoworkerLog } from "@/lib/db/logs";
import {
  getWebchatSessionById,
  updateWebchatSessionContact
} from "@/lib/webchat/db";
import {
  linkCustomerEmail,
  recordInteractionAndIncrement
} from "@/lib/customer-memory/db";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

const mockLog = vi.mocked(insertCoworkerLog);
const mockGetSession = vi.mocked(getWebchatSessionById);
const mockMerge = vi.mocked(updateWebchatSessionContact);
const mockLink = vi.mocked(linkCustomerEmail);
const mockRollup = vi.mocked(recordInteractionAndIncrement);

const sessionRow = {
  id: SESSION,
  business_id: BIZ,
  session_token_sha256: "h",
  visitor_name: null,
  visitor_email: null,
  visitor_phone: null,
  rowboat_conversation_id: null,
  rowboat_state: null,
  last_seen_at: "2026-07-10T00:00:00Z",
  created_at: "2026-07-10T00:00:00Z"
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLog.mockResolvedValue({} as never);
});

describe("captureWebchatLead", () => {
  it("refuses an empty capture without writing anything", async () => {
    expect(await captureWebchatLead(BIZ, { name: "  ", notes: "" })).toEqual({
      ok: false,
      detail: "empty_capture"
    });
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("refuses a capture with no way to reach the visitor (nothing written, model told nothing was saved)", async () => {
    // The production bug: visitor said "go ahead and capture my details"
    // without ever sharing any — an interest-only capture succeeded and
    // the assistant claimed success. Now it refuses with guidance.
    const out = await captureWebchatLead(BIZ, {
      interest: "HIPAA compliance discussion",
      notes: "Wants the team to reach out"
    });
    expect(out).toEqual({
      ok: false,
      detail: "no_contact_details",
      message: WEBCHAT_CAPTURE_NO_CONTACT_MESSAGE
    });
    expect(WEBCHAT_CAPTURE_NO_CONTACT_MESSAGE).toContain("Nothing was saved");
    expect(mockLog).not.toHaveBeenCalled();

    // A bare name is just as unreachable.
    const nameOnly = await captureWebchatLead(BIZ, { name: "Ada" });
    expect(nameOnly.ok).toBe(false);
    expect(mockLog).not.toHaveBeenCalled();

    // Session resolves but has no contact on file either → still refused.
    mockGetSession.mockResolvedValueOnce(sessionRow);
    const noSessionContact = await captureWebchatLead(BIZ, {
      interest: "pricing",
      sessionRef: SESSION
    });
    expect(noSessionContact.ok).toBe(false);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("allows an interest-only capture when the session already has contact on file", async () => {
    mockGetSession.mockResolvedValueOnce({
      ...sessionRow,
      visitor_phone: "+15551234567"
    });
    const out = await captureWebchatLead(BIZ, {
      interest: "Standard plan questions",
      sessionRef: SESSION
    });
    expect(out.ok).toBe(true);
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0][0].log_payload).toMatchObject({
      interest: "Standard plan questions",
      sessionId: SESSION
    });
  });

  it("logs the lead with a webchat task type and trimmed fields", async () => {
    const out = await captureWebchatLead(BIZ, {
      name: " Ada Lovelace ",
      email: "ada@example.com",
      interest: "Kitchen remodel",
      sessionRef: undefined
    });
    expect(out.ok).toBe(true);
    expect(mockLog).toHaveBeenCalledTimes(1);
    const row = mockLog.mock.calls[0][0];
    expect(row.business_id).toBe(BIZ);
    expect(row.task_type).toBe("webchat");
    expect(row.status).toBe("success");
    expect(row.log_payload).toMatchObject({
      source: "webchat_capture_lead",
      visitorName: "Ada Lovelace",
      interest: "Kitchen remodel",
      visitorPhone: null,
      visitorEmail: "ada@example.com",
      sessionId: null
    });
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockMerge).not.toHaveBeenCalled();
  });

  it("attributes to the session when the ref resolves to the SAME business", async () => {
    mockGetSession.mockResolvedValueOnce(sessionRow);
    const out = await captureWebchatLead(BIZ, {
      name: "Ada",
      email: "ada@example.com",
      sessionRef: SESSION
    });
    expect(out.ok).toBe(true);
    expect(mockLog.mock.calls[0][0].log_payload).toMatchObject({ sessionId: SESSION });
    expect(mockMerge).toHaveBeenCalledWith(SESSION, {
      name: "Ada",
      email: "ada@example.com",
      phone: null
    });
  });

  it("drops cross-tenant and malformed session refs (lead still logged)", async () => {
    mockGetSession.mockResolvedValueOnce({ ...sessionRow, business_id: "other" });
    const crossTenant = await captureWebchatLead(BIZ, {
      name: "Eve",
      email: "eve@example.com",
      sessionRef: SESSION
    });
    expect(crossTenant.ok).toBe(true);
    expect(mockLog.mock.calls[0][0].log_payload).toMatchObject({ sessionId: null });
    expect(mockMerge).not.toHaveBeenCalled();

    const malformed = await captureWebchatLead(BIZ, {
      name: "Eve",
      email: "eve@example.com",
      sessionRef: "not-a-uuid"
    });
    expect(malformed.ok).toBe(true);
    expect(mockGetSession).toHaveBeenCalledTimes(1); // malformed ref never hits the DB
  });

  it("tolerates a failed session lookup / merge (warn + continue, Error and non-Error shapes)", async () => {
    mockGetSession.mockRejectedValueOnce(new Error("db down"));
    const lookupFail = await captureWebchatLead(BIZ, {
      name: "Ada",
      email: "ada@example.com",
      sessionRef: SESSION
    });
    expect(lookupFail.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "webchat lead-capture: session lookup failed",
      expect.objectContaining({ error: "db down" })
    );

    // Non-Error rejection (PG drivers can surface plain strings).
    mockGetSession.mockRejectedValueOnce("lookup boom");
    const lookupFailStr = await captureWebchatLead(BIZ, {
      name: "Ada",
      email: "ada@example.com",
      sessionRef: SESSION
    });
    expect(lookupFailStr.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "webchat lead-capture: session lookup failed",
      expect.objectContaining({ error: "lookup boom" })
    );

    vi.clearAllMocks();
    mockLog.mockResolvedValue({} as never);
    mockGetSession.mockResolvedValueOnce(sessionRow);
    mockMerge.mockRejectedValueOnce("merge boom");
    const mergeFail = await captureWebchatLead(BIZ, {
      name: "Ada",
      email: "ada@example.com",
      sessionRef: SESSION
    });
    expect(mergeFail.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "webchat lead-capture: session contact merge failed",
      expect.objectContaining({ error: "merge boom" })
    );

    mockGetSession.mockResolvedValueOnce(sessionRow);
    mockMerge.mockRejectedValueOnce(new Error("merge err"));
    const mergeFailErr = await captureWebchatLead(BIZ, {
      name: "Ada",
      email: "ada@example.com",
      sessionRef: SESSION
    });
    expect(mergeFailErr.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "webchat lead-capture: session contact merge failed",
      expect.objectContaining({ error: "merge err" })
    );
  });

  it("rolls a coercible phone up to a webchat contact and links the email", async () => {
    const out = await captureWebchatLead(BIZ, {
      name: "Ada",
      phone: "(555) 123-4567",
      email: "ada@example.com"
    });
    expect(out.ok).toBe(true);
    expect(mockRollup).toHaveBeenCalledWith(BIZ, "+15551234567", "webchat", {
      displayName: "Ada"
    });
    expect(mockLink).toHaveBeenCalledWith(BIZ, "+15551234567", "ada@example.com");
  });

  it("survives a contact-rollup failure (Error and non-Error shapes)", async () => {
    mockRollup.mockRejectedValueOnce(new Error("rollup boom"));
    const out = await captureWebchatLead(BIZ, { phone: "5551234567" });
    expect(out.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "webchat lead-capture: contact rollup failed",
      expect.objectContaining({ error: "rollup boom" })
    );

    mockRollup.mockRejectedValueOnce("rollup str boom");
    const outStr = await captureWebchatLead(BIZ, { phone: "5551234567" });
    expect(outStr.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "webchat lead-capture: contact rollup failed",
      expect.objectContaining({ error: "rollup str boom" })
    );
  });

  it("skips rollup+link without a coercible phone, and the link without an email, surviving a link failure", async () => {
    await captureWebchatLead(BIZ, { phone: "12", email: "a@b.com" });
    expect(mockRollup).not.toHaveBeenCalled();
    await captureWebchatLead(BIZ, { phone: "(555) 123-4567" });
    expect(mockLink).not.toHaveBeenCalled();

    mockLink.mockRejectedValueOnce(new Error("link boom"));
    const out = await captureWebchatLead(BIZ, {
      phone: "5551234567",
      email: "a@b.com"
    });
    expect(out.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "webchat lead-capture: linkCustomerEmail failed",
      expect.objectContaining({ error: "link boom" })
    );

    // Non-Error rejection shape.
    mockLink.mockRejectedValueOnce("link str boom");
    const outStr = await captureWebchatLead(BIZ, {
      phone: "5551234567",
      email: "a@b.com"
    });
    expect(outStr.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "webchat lead-capture: linkCustomerEmail failed",
      expect.objectContaining({ error: "link str boom" })
    );
  });
});
