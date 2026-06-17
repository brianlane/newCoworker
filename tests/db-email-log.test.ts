import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => defaultClientSpy(...a)
}));

import {
  EMAIL_LOG_DEFAULT_LIMIT,
  EMAIL_LOG_MAX_LIMIT,
  getEmailBody,
  listEmailLog,
  recordInboundTriggerEmail,
  recordOutboundAssistantEmail,
  recordTenantMailboxInbound
} from "@/lib/db/email-log";

function listChain(result: { data: unknown; error: { message: string } | null }) {
  const limit = vi.fn().mockResolvedValue(result);
  const order = vi.fn(() => ({ limit }));
  const eq = vi.fn(() => ({ order }));
  const select = vi.fn(() => ({ eq }));
  return { select, eq, order, limit };
}

function makeDb(c: ReturnType<typeof listChain>) {
  return { from: vi.fn(() => c) };
}

const ROW = {
  id: "e1",
  business_id: "biz",
  direction: "outbound",
  to_email: "lead@example.com",
  from_email: "New Coworker <contact@newcoworker.com>",
  subject: "Re: Your inquiry",
  body_preview: "Hi there",
  source: "ai_flow",
  run_id: "run-1",
  flow_id: "flow-1",
  provider_message_id: "rs-1",
  created_at: "2026-06-12T10:00:00Z"
};

function singleChain(result: { data: unknown; error: { message: string } | null }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eqId = vi.fn(() => ({ maybeSingle }));
  const eqBiz = vi.fn(() => ({ eq: eqId }));
  const select = vi.fn(() => ({ eq: eqBiz }));
  return { select, eqBiz, eqId, maybeSingle };
}

beforeEach(() => {
  defaultClientSpy.mockReset();
});

describe("listEmailLog", () => {
  it("returns rows newest-first with the default limit", async () => {
    const c = listChain({ data: [ROW], error: null });
    const rows = await listEmailLog("biz", {}, makeDb(c) as never);
    expect(rows).toEqual([ROW]);
    expect(c.eq).toHaveBeenCalledWith("business_id", "biz");
    expect(c.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(c.limit).toHaveBeenCalledWith(EMAIL_LOG_DEFAULT_LIMIT);
  });

  it("clamps oversized and tiny limits", async () => {
    const c = listChain({ data: [], error: null });
    await listEmailLog("biz", { limit: 99999 }, makeDb(c) as never);
    expect(c.limit).toHaveBeenCalledWith(EMAIL_LOG_MAX_LIMIT);
    await listEmailLog("biz", { limit: 0 }, makeDb(c) as never);
    expect(c.limit).toHaveBeenCalledWith(1);
    await listEmailLog("biz", { limit: Number.NaN }, makeDb(c) as never);
    expect(c.limit).toHaveBeenCalledWith(EMAIL_LOG_DEFAULT_LIMIT);
  });

  it("handles null data and surfaces query errors", async () => {
    const empty = listChain({ data: null, error: null });
    await expect(listEmailLog("biz", {}, makeDb(empty) as never)).resolves.toEqual([]);
    const broken = listChain({ data: null, error: { message: "boom" } });
    await expect(listEmailLog("biz", {}, makeDb(broken) as never)).rejects.toThrow(
      "listEmailLog: boom"
    );
  });

  it("uses the default service client when none is injected", async () => {
    const c = listChain({ data: [], error: null });
    defaultClientSpy.mockResolvedValueOnce(makeDb(c));
    await expect(listEmailLog("biz")).resolves.toEqual([]);
  });
});

describe("getEmailBody", () => {
  it("returns the body + attachments scoped by business + id", async () => {
    const att = {
      filename: "quote.pdf",
      mime_type: "application/pdf",
      size_bytes: 1234,
      storage_path: "inbound/abc/0-quote.pdf"
    };
    const c = singleChain({
      data: { body_preview: "hi", body_full: "hi there", attachments: [att] },
      error: null
    });
    const body = await getEmailBody("biz", "e1", makeDb(c as never) as never);
    expect(body).toEqual({ body_preview: "hi", body_full: "hi there", attachments: [att] });
    expect(c.select).toHaveBeenCalledWith("body_preview, body_full, attachments");
    expect(c.eqBiz).toHaveBeenCalledWith("business_id", "biz");
    expect(c.eqId).toHaveBeenCalledWith("id", "e1");
  });

  it("returns null when the id is not found for the business", async () => {
    const c = singleChain({ data: null, error: null });
    expect(await getEmailBody("biz", "missing", makeDb(c as never) as never)).toBeNull();
  });

  it("throws on a query error", async () => {
    const c = singleChain({ data: null, error: { message: "boom" } });
    await expect(getEmailBody("biz", "e1", makeDb(c as never) as never)).rejects.toThrow(
      "getEmailBody: boom"
    );
  });

  it("defaults attachments to [] and uses the default client when none is injected", async () => {
    const c = singleChain({ data: { body_preview: "p", body_full: null }, error: null });
    defaultClientSpy.mockResolvedValueOnce(makeDb(c as never));
    expect(await getEmailBody("biz", "e1")).toEqual({
      body_preview: "p",
      body_full: null,
      attachments: []
    });
  });
});

describe("recordInboundTriggerEmail", () => {
  const input = {
    businessId: "biz",
    fromEmail: "leads@rx.com",
    subject: "New referral",
    bodyText: "x".repeat(600),
    flowId: "flow-1",
    runId: "run-1",
    providerMessageId: "m1"
  };

  it("inserts an inbound row with a capped body preview", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const db = { from: vi.fn(() => ({ insert })) };
    await recordInboundTriggerEmail(input, db as never);
    expect(db.from).toHaveBeenCalledWith("email_log");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz",
        direction: "inbound",
        source: "email_trigger",
        from_email: "leads@rx.com",
        subject: "New referral",
        body_preview: "x".repeat(500),
        run_id: "run-1",
        flow_id: "flow-1",
        provider_message_id: "m1"
      })
    );
  });

  it("only logs on insert error (best-effort)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const insert = vi.fn().mockResolvedValue({ error: { message: "down" } });
    const db = { from: vi.fn(() => ({ insert })) };
    await expect(recordInboundTriggerEmail(input, db as never)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith("recordInboundTriggerEmail", "down");
    errSpy.mockRestore();
  });

  it("uses the default service client when none is injected", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    defaultClientSpy.mockResolvedValueOnce({ from: vi.fn(() => ({ insert })) });
    await recordInboundTriggerEmail(input);
    expect(insert).toHaveBeenCalled();
  });
});

describe("recordTenantMailboxInbound", () => {
  const input = {
    businessId: "biz",
    toEmail: "amy@newcoworker.com",
    fromEmail: "jane@example.com",
    subject: "Quote please",
    bodyText: "z".repeat(600),
    flowId: "flow-1",
    runId: "run-1",
    providerMessageId: "<m1@x>"
  };

  it("inserts an inbound tenant-mailbox row with a capped preview", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const db = { from: vi.fn(() => ({ insert })) };
    await recordTenantMailboxInbound(input, db as never);
    expect(db.from).toHaveBeenCalledWith("email_log");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz",
        direction: "inbound",
        source: "tenant_mailbox_inbound",
        to_email: "amy@newcoworker.com",
        from_email: "jane@example.com",
        subject: "Quote please",
        body_preview: "z".repeat(500),
        body_full: "z".repeat(600),
        run_id: "run-1",
        flow_id: "flow-1",
        provider_message_id: "<m1@x>"
      })
    );
  });

  it("defaults optional fields to null", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const db = { from: vi.fn(() => ({ insert })) };
    await recordTenantMailboxInbound(
      { businessId: "biz", toEmail: "a@nc.com", fromEmail: "b@x.com", subject: "s", bodyText: "t" },
      db as never
    );
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: null, flow_id: null, provider_message_id: null })
    );
  });

  it("only logs on insert error (best-effort)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const insert = vi.fn().mockResolvedValue({ error: { message: "down" } });
    const db = { from: vi.fn(() => ({ insert })) };
    await expect(recordTenantMailboxInbound(input, db as never)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith("recordTenantMailboxInbound", "down");
    errSpy.mockRestore();
  });

  it("uses the default service client when none is injected", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    defaultClientSpy.mockResolvedValueOnce({ from: vi.fn(() => ({ insert })) });
    await recordTenantMailboxInbound(input);
    expect(insert).toHaveBeenCalled();
  });

  it("never throws when the client cannot be created", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    defaultClientSpy.mockRejectedValueOnce(new Error("no env"));
    await expect(recordTenantMailboxInbound(input)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith("recordTenantMailboxInbound", "no env");
    defaultClientSpy.mockRejectedValueOnce("weird");
    await expect(recordTenantMailboxInbound(input)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith("recordTenantMailboxInbound", "weird");
    errSpy.mockRestore();
  });
});

describe("recordOutboundAssistantEmail", () => {
  const input = {
    businessId: "biz",
    toEmail: "lead@example.com",
    subject: "Following up",
    bodyText: "y".repeat(600),
    source: "dashboard_chat" as const,
    providerMessageId: "gm-1"
  };

  it("inserts an outbound row with a capped body preview and the surface source", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const db = { from: vi.fn(() => ({ insert })) };
    await recordOutboundAssistantEmail(input, db as never);
    expect(db.from).toHaveBeenCalledWith("email_log");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz",
        direction: "outbound",
        source: "dashboard_chat",
        to_email: "lead@example.com",
        from_email: null,
        subject: "Following up",
        body_preview: "y".repeat(500),
        run_id: null,
        flow_id: null,
        provider_message_id: "gm-1"
      })
    );
  });

  it("stores cc as CSV and treats an empty bcc array as null", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const db = { from: vi.fn(() => ({ insert })) };
    await recordOutboundAssistantEmail(
      { ...input, ccEmails: ["a@x.com", "b@x.com"], bccEmails: [] },
      db as never
    );
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ cc_email: "a@x.com, b@x.com", bcc_email: null })
    );
  });

  it("defaults missing cc/bcc to null", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const db = { from: vi.fn(() => ({ insert })) };
    await recordOutboundAssistantEmail(input, db as never);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ cc_email: null, bcc_email: null })
    );
  });

  it("defaults a missing providerMessageId to null", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const db = { from: vi.fn(() => ({ insert })) };
    await recordOutboundAssistantEmail(
      { ...input, source: "sms_assistant", providerMessageId: undefined },
      db as never
    );
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ source: "sms_assistant", provider_message_id: null })
    );
  });

  it("only logs on insert error (best-effort)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const insert = vi.fn().mockResolvedValue({ error: { message: "down" } });
    const db = { from: vi.fn(() => ({ insert })) };
    await expect(recordOutboundAssistantEmail(input, db as never)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith("recordOutboundAssistantEmail", "down");
    errSpy.mockRestore();
  });

  it("uses the default service client when none is injected", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    defaultClientSpy.mockResolvedValueOnce({ from: vi.fn(() => ({ insert })) });
    await recordOutboundAssistantEmail(input);
    expect(insert).toHaveBeenCalled();
  });

  it("never throws, even when the client cannot be created", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    defaultClientSpy.mockRejectedValueOnce(new Error("no env"));
    await expect(recordOutboundAssistantEmail(input)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith("recordOutboundAssistantEmail", "no env");
    defaultClientSpy.mockRejectedValueOnce("weird");
    await expect(recordOutboundAssistantEmail(input)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith("recordOutboundAssistantEmail", "weird");
    errSpy.mockRestore();
  });
});
