import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => defaultClientSpy(...a)
}));

import {
  EMAIL_LOG_DEFAULT_LIMIT,
  EMAIL_LOG_MAX_LIMIT,
  listEmailLog,
  recordInboundTriggerEmail
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
