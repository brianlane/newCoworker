import { beforeEach, describe, expect, it, vi } from "vitest";

// The residency read-routing layer is unit-tested in tests/residency-read.test.ts
// and the VPS branches of this module in tests/residency-read-flip.test.ts.
// Pin CENTRAL mode here so these tests exercise the Supabase path unchanged.
vi.mock("@/lib/residency/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/residency/read")>();
  return { ...actual, isVpsReadMode: vi.fn(async () => false) };
});

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => defaultClientSpy(...a)
}));

vi.mock("@/lib/residency/row-delete", () => ({
  softDeleteContentRows: vi.fn()
}));

import {
  EMAIL_LOG_DEFAULT_LIMIT,
  EMAIL_LOG_MAX_LIMIT,
  getEmailBody,
  getEmailLogRow,
  threadsAnsweredByFlow,
  listEmailLog,
  listEmailLogForAddress,
  recordInboundTriggerEmail,
  recordOutboundAssistantEmail,
  linkTenantMailboxInboundRun,
  recordTenantMailboxInbound,
  softDeleteEmailLogEntry
} from "@/lib/db/email-log";
import { softDeleteContentRows } from "@/lib/residency/row-delete";

/** listEmailLog chains select → eq → is(deleted_at) → order → limit. */
function listChain(result: { data: unknown; error: { message: string } | null }) {
  const limit = vi.fn().mockResolvedValue(result);
  const order = vi.fn(() => ({ limit }));
  const is = vi.fn(() => ({ order }));
  const eq = vi.fn(() => ({ is }));
  const select = vi.fn(() => ({ eq }));
  return { select, eq, is, order, limit };
}

/** listEmailLogForAddress chains select → eq → is(deleted_at) → or → order → limit. */
function addressChain(result: { data: unknown; error: { message: string } | null }) {
  const limit = vi.fn().mockResolvedValue(result);
  const order = vi.fn(() => ({ limit }));
  const or = vi.fn(() => ({ order }));
  const is = vi.fn(() => ({ or }));
  const eq = vi.fn(() => ({ is }));
  const select = vi.fn(() => ({ eq }));
  return { select, eq, is, or, order, limit };
}

function makeDb<T>(c: T) {
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

/** getEmailBody chains select → eq(biz) → eq(id) → is(deleted_at) → maybeSingle. */
function singleChain(result: { data: unknown; error: { message: string } | null }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const is = vi.fn(() => ({ maybeSingle }));
  const eqId = vi.fn(() => ({ is }));
  const eqBiz = vi.fn(() => ({ eq: eqId }));
  const select = vi.fn(() => ({ eq: eqBiz }));
  return { select, eqBiz, eqId, is, maybeSingle };
}

beforeEach(() => {
  defaultClientSpy.mockReset();
});

describe("email_log importance normalization", () => {
  it("keeps a stored score and nulls anything that is not a number", async () => {
    // The true branch matters: without it a scored row would read back unscored
    // and the Emails page sort would silently do nothing.
    const c = listChain({ data: [{ ...ROW, importance: 7 }], error: null });
    const [row] = await listEmailLog("biz", {}, makeDb(c) as never);
    expect(row.importance).toBe(7);

    const c2 = listChain({ data: [{ ...ROW, importance: "7" }], error: null });
    const [row2] = await listEmailLog("biz", {}, makeDb(c2) as never);
    expect(row2.importance).toBeNull();
  });
});

describe("listEmailLog", () => {
  it("returns rows newest-first with the default limit", async () => {
    const c = listChain({ data: [ROW], error: null });
    const rows = await listEmailLog("biz", {}, makeDb(c) as never);
    expect(rows).toEqual([
      {
        ...ROW,
        is_read: false,
        archived_at: null,
        folder: null,
        labels: [],
        importance: null
      }
    ]);
    expect(c.eq).toHaveBeenCalledWith("business_id", "biz");
    // Soft-deleted mail must never show in the inbox.
    expect(c.is).toHaveBeenCalledWith("deleted_at", null);
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

describe("listEmailLogForAddress", () => {
  it("matches FROM or TO the address (case-insensitive) newest-first, scoped to the business", async () => {
    const c = addressChain({ data: [ROW], error: null });
    const rows = await listEmailLogForAddress("biz", "lead@example.com", {}, makeDb(c) as never);
    expect(rows).toEqual([ROW]);
    expect(c.eq).toHaveBeenCalledWith("business_id", "biz");
    expect(c.or).toHaveBeenCalledWith(
      `from_email.ilike."lead@example.com",to_email.ilike."lead@example.com"`
    );
    expect(c.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(c.limit).toHaveBeenCalledWith(EMAIL_LOG_DEFAULT_LIMIT);
  });

  it("escapes LIKE/PostgREST metacharacters so a local-part like joe_smith is a literal", async () => {
    const c = addressChain({ data: [], error: null });
    await listEmailLogForAddress("biz", "joe_smith@x.com", {}, makeDb(c) as never);
    // `_` → `\_` (LIKE), then the backslash is doubled for the PostgREST
    // double-quoted literal → `\\_`.
    expect(c.or).toHaveBeenCalledWith(
      `from_email.ilike."joe\\\\_smith@x.com",to_email.ilike."joe\\\\_smith@x.com"`
    );
  });

  it("trims and short-circuits to [] for an empty/whitespace address (never queries)", async () => {
    const c = addressChain({ data: [ROW], error: null });
    expect(await listEmailLogForAddress("biz", "   ", {}, makeDb(c) as never)).toEqual([]);
    expect(c.select).not.toHaveBeenCalled();
  });

  it("clamps oversized and tiny limits", async () => {
    const c = addressChain({ data: [], error: null });
    await listEmailLogForAddress("biz", "a@x.com", { limit: 99999 }, makeDb(c) as never);
    expect(c.limit).toHaveBeenCalledWith(EMAIL_LOG_MAX_LIMIT);
    await listEmailLogForAddress("biz", "a@x.com", { limit: 0 }, makeDb(c) as never);
    expect(c.limit).toHaveBeenCalledWith(1);
    await listEmailLogForAddress("biz", "a@x.com", { limit: Number.NaN }, makeDb(c) as never);
    expect(c.limit).toHaveBeenCalledWith(EMAIL_LOG_DEFAULT_LIMIT);
  });

  it("handles null data and surfaces query errors", async () => {
    const empty = addressChain({ data: null, error: null });
    await expect(
      listEmailLogForAddress("biz", "a@x.com", {}, makeDb(empty) as never)
    ).resolves.toEqual([]);
    const broken = addressChain({ data: null, error: { message: "boom" } });
    await expect(
      listEmailLogForAddress("biz", "a@x.com", {}, makeDb(broken) as never)
    ).rejects.toThrow("listEmailLogForAddress: boom");
  });

  it("uses the default service client when none is injected", async () => {
    const c = addressChain({ data: [], error: null });
    defaultClientSpy.mockResolvedValueOnce(makeDb(c));
    await expect(listEmailLogForAddress("biz", "a@x.com")).resolves.toEqual([]);
  });
});

describe("recordOutboundAssistantEmail: the row has to be findable by thread", () => {
  /**
   * Every outbound row in production carried thread_id NULL until Aug 10 2026,
   * so `threadsWeHaveRepliedOn` could never match one and the signal it feeds
   * was dead. Asserting the INSERT payload rather than a helper's return
   * value, because the column being written is the whole point.
   */
  it("writes the conversation id when the caller threaded the send", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const db = { from: vi.fn(() => ({ insert })) };
    await recordOutboundAssistantEmail(
      {
        businessId: "biz",
        toEmail: "a@b.c",
        subject: "Re: hi",
        bodyText: "hello",
        source: "email_coworker",
        fromEmail: "team@newcoworker.com",
        threadId: "t-7"
      },
      db as never
    );
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ thread_id: "t-7" }));
  });

  it("writes null rather than an empty string when there is no thread", async () => {
    // An empty string would match nothing and read as a real id in the column.
    const insert = vi.fn().mockResolvedValue({ error: null });
    const db = { from: vi.fn(() => ({ insert })) };
    for (const threadId of [undefined, "", "   "]) {
      await recordOutboundAssistantEmail(
        {
          businessId: "biz",
          toEmail: "a@b.c",
          subject: "hi",
          bodyText: "hello",
          source: "dashboard_chat",
          fromEmail: null,
          ...(threadId === undefined ? {} : { threadId })
        },
        db as never
      );
    }
    for (const call of insert.mock.calls) {
      expect((call[0] as { thread_id: unknown }).thread_id).toBeNull();
    }
  });
});

describe("threadsAnsweredByFlow", () => {
  /**
   * "Did a GATED flow reply here", not "did anything of ours reply here".
   * The discriminator is run_id: the flow worker stamps its run on every email
   * it logs, while the coworker and the outreach sweep both write null.
   */
  const chain = (result: { data: unknown; error: { message: string } | null }) => {
    const inFn = vi.fn().mockResolvedValue(result);
    const notFn = vi.fn(() => ({ in: inFn }));
    const eqDir = vi.fn(() => ({ not: notFn }));
    const eqBiz = vi.fn(() => ({ eq: eqDir }));
    const select = vi.fn(() => ({ eq: eqBiz }));
    return { db: { from: vi.fn(() => ({ select })) }, select, eqBiz, eqDir, notFn, inFn };
  };

  it("matches only outbound rows that carry a run id", async () => {
    const c = chain({ data: [{ thread_id: "t1" }], error: null });
    expect([...(await threadsAnsweredByFlow("biz", ["t1", "t2"], c.db as never))]).toEqual(["t1"]);
    expect(c.eqDir).toHaveBeenCalledWith("direction", "outbound");
    // The whole distinction: a coworker or outreach send writes run_id null,
    // and blocking on those would stop the coworker after its own first reply.
    expect(c.notFn).toHaveBeenCalledWith("run_id", "is", null);
  });

  it("dedupes and drops blanks, and skips the query when there is nothing to ask", async () => {
    const c = chain({ data: [], error: null });
    await threadsAnsweredByFlow("biz", ["t1", "t1", "  ", "t2"], c.db as never);
    expect(c.inFn).toHaveBeenCalledWith("thread_id", ["t1", "t2"]);

    const c2 = chain({ data: [], error: null });
    expect(await threadsAnsweredByFlow("biz", ["", " "], c2.db as never)).toEqual(new Set());
    expect(c2.select).not.toHaveBeenCalled();
  });

  it("fails OPEN, on a query error and on a non-Error throw alike", async () => {
    // A read failure costs one duplicate reply; failing closed would silence
    // the coworker on every thread it owns.
    const c = chain({ data: null, error: { message: "boom" } });
    expect(await threadsAnsweredByFlow("biz", ["t1"], c.db as never)).toEqual(new Set());
    const throwing = {
      from: () => {
        throw "connection reset";
      }
    };
    expect(await threadsAnsweredByFlow("biz", ["t1"], throwing as never)).toEqual(new Set());
  });

  it("treats a null payload as no flow-answered threads", async () => {
    // PostgREST can answer with neither rows nor an error.
    const c = chain({ data: null, error: null });
    expect(await threadsAnsweredByFlow("biz", ["t1"], c.db as never)).toEqual(new Set());
  });

  it("ignores null thread ids and falls back to the default client", async () => {
    const c = chain({ data: [{ thread_id: null }, { thread_id: "t9" }], error: null });
    expect([...(await threadsAnsweredByFlow("biz", ["t9"], c.db as never))]).toEqual(["t9"]);
    const c2 = chain({ data: [{ thread_id: "t8" }], error: null });
    defaultClientSpy.mockResolvedValue(c2.db);
    expect([...(await threadsAnsweredByFlow("biz", ["t8"]))]).toEqual(["t8"]);
  });
});

describe("getEmailLogRow", () => {
  /**
   * The deep link in the HQ alert names one row by id. The Emails page renders
   * only the newest 100, and the reading pane resolves its selection against
   * that array, so without this fetcher a link tapped days later opens the
   * page to nothing.
   */
  it("returns the normalized row for an id inside the business", async () => {
    const c = singleChain({ data: ROW, error: null });
    expect(await getEmailLogRow("biz", "e1", makeDb(c) as never)).toEqual({
      ...ROW,
      is_read: false,
      archived_at: null,
      folder: null,
      labels: [],
      importance: null
    });
    // Scoped by business AND excluding soft-deleted rows: a guessed uuid must
    // never read another tenant's mail.
    expect(c.eqBiz).toHaveBeenCalledWith("business_id", "biz");
    expect(c.eqId).toHaveBeenCalledWith("id", "e1");
    expect(c.is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("returns null for an id that is missing or belongs to someone else", async () => {
    const c = singleChain({ data: null, error: null });
    expect(await getEmailLogRow("biz", "nope", makeDb(c) as never)).toBeNull();
  });

  it("returns null for a blank id without touching the database", async () => {
    const c = singleChain({ data: ROW, error: null });
    expect(await getEmailLogRow("biz", "   ", makeDb(c) as never)).toBeNull();
    expect(c.select).not.toHaveBeenCalled();
  });

  it("throws on a query error rather than pretending the row is gone", async () => {
    const c = singleChain({ data: null, error: { message: "boom" } });
    await expect(getEmailLogRow("biz", "e1", makeDb(c) as never)).rejects.toThrow(
      "getEmailLogRow: boom"
    );
  });

  it("falls back to the default service client when none is passed", async () => {
    const c = singleChain({ data: ROW, error: null });
    defaultClientSpy.mockResolvedValue(makeDb(c));
    expect((await getEmailLogRow("biz", "e1"))?.id).toBe(ROW.id);
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
      data: { body_preview: "hi", body_full: "hi there", body_html: "<b>hi</b>", attachments: [att] },
      error: null
    });
    const body = await getEmailBody("biz", "e1", makeDb(c as never) as never);
    expect(body).toEqual({
      body_preview: "hi",
      body_full: "hi there",
      body_html: "<b>hi</b>",
      attachments: [att]
    });
    expect(c.select).toHaveBeenCalledWith("body_preview, body_full, body_html, attachments");
    expect(c.eqBiz).toHaveBeenCalledWith("business_id", "biz");
    expect(c.eqId).toHaveBeenCalledWith("id", "e1");
    expect(c.is).toHaveBeenCalledWith("deleted_at", null);
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
      body_html: null,
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

  /** insert().select().single() — the id is returned for the trigger scope. */
  const insertReturning = (result: { data?: unknown; error?: { message: string } | null }) =>
    vi.fn(() => ({ select: () => ({ single: () => Promise.resolve(result) }) }));

  it("inserts an inbound row with a capped body preview, and answers its id", async () => {
    const insert = insertReturning({ data: { id: "elog-9" }, error: null });
    const db = { from: vi.fn(() => ({ insert })) };
    // The id is the whole point: {{trigger.email_log_id}} is what a reply
    // resolves its thread from, and returning void left it empty in the scope.
    expect(await recordInboundTriggerEmail(input, db as never)).toBe("elog-9");
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
    const insert = insertReturning({ data: null, error: { message: "down" } });
    const db = { from: vi.fn(() => ({ insert })) };
    // Null, not a throw: a logging failure costs the reply its threading,
    // never the run.
    await expect(recordInboundTriggerEmail(input, db as never)).resolves.toBeNull();
    expect(errSpy).toHaveBeenCalledWith("recordInboundTriggerEmail", "down");
    errSpy.mockRestore();
  });

  it("answers null when the insert reports success but returns no row", async () => {
    // A driver that resolves { data: null, error: null } must not produce an
    // undefined id, which would render as the string "undefined" in
    // {{trigger.email_log_id}} and resolve to no thread at all.
    const insert = insertReturning({ data: null, error: null });
    const db = { from: vi.fn(() => ({ insert })) };
    expect(await recordInboundTriggerEmail(input, db as never)).toBeNull();
  });

  it("uses the default service client when none is injected", async () => {
    const insert = insertReturning({ data: { id: "elog-1" }, error: null });
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

  /** insert().select("id").maybeSingle() chain returning the given result. */
  const insertingDb = (result: { data: unknown; error: { message: string } | null }) => {
    const maybeSingle = vi.fn().mockResolvedValue(result);
    const select = vi.fn(() => ({ maybeSingle }));
    const insert = vi.fn(() => ({ select }));
    return { insert, db: { from: vi.fn(() => ({ insert })) } };
  };

  it("inserts an inbound tenant-mailbox row with a capped preview", async () => {
    const { insert, db } = insertingDb({ data: { id: "log-1" }, error: null });
    const id = await recordTenantMailboxInbound({ ...input, bodyHtml: "<p>z</p>" }, db as never);
    expect(id).toBe("log-1");
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
        body_html: "<p>z</p>",
        run_id: "run-1",
        flow_id: "flow-1",
        provider_message_id: "<m1@x>"
      })
    );
  });

  it("defaults optional fields to null and a missing returned id to null", async () => {
    const { insert, db } = insertingDb({ data: null, error: null });
    const id = await recordTenantMailboxInbound(
      { businessId: "biz", toEmail: "a@nc.com", fromEmail: "b@x.com", subject: "s", bodyText: "t" },
      db as never
    );
    expect(id).toBeNull();
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        run_id: null,
        flow_id: null,
        provider_message_id: null,
        body_html: null
      })
    );
  });

  it("only logs on insert error (best-effort), returning null", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = insertingDb({ data: null, error: { message: "down" } });
    await expect(recordTenantMailboxInbound(input, db as never)).resolves.toBeNull();
    expect(errSpy).toHaveBeenCalledWith("recordTenantMailboxInbound", "down");
    errSpy.mockRestore();
  });

  it("uses the default service client when none is injected", async () => {
    const { insert, db } = insertingDb({ data: { id: "log-2" }, error: null });
    defaultClientSpy.mockResolvedValueOnce(db);
    expect(await recordTenantMailboxInbound(input)).toBe("log-2");
    expect(insert).toHaveBeenCalled();
  });

  it("never throws when the client cannot be created", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    defaultClientSpy.mockRejectedValueOnce(new Error("no env"));
    await expect(recordTenantMailboxInbound(input)).resolves.toBeNull();
    expect(errSpy).toHaveBeenCalledWith("recordTenantMailboxInbound", "no env");
    defaultClientSpy.mockRejectedValueOnce("weird");
    await expect(recordTenantMailboxInbound(input)).resolves.toBeNull();
    expect(errSpy).toHaveBeenCalledWith("recordTenantMailboxInbound", "weird");
    errSpy.mockRestore();
  });
});

describe("linkTenantMailboxInboundRun", () => {
  const linkage = { flowId: "flow-1", runId: "run-1" };

  /** update().eq().eq() chain resolving to the given result. */
  const updatingDb = (result: { error: { message: string } | null }) => {
    const eq2 = vi.fn().mockResolvedValue(result);
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    const update = vi.fn(() => ({ eq: eq1 }));
    return { update, eq1, eq2, db: { from: vi.fn(() => ({ update })) } };
  };

  it("stamps the flow/run linkage scoped to the business + row", async () => {
    const { update, eq1, eq2, db } = updatingDb({ error: null });
    await linkTenantMailboxInboundRun("biz", "log-1", linkage, db as never);
    expect(db.from).toHaveBeenCalledWith("email_log");
    expect(update).toHaveBeenCalledWith({ flow_id: "flow-1", run_id: "run-1" });
    expect(eq1).toHaveBeenCalledWith("business_id", "biz");
    expect(eq2).toHaveBeenCalledWith("id", "log-1");
  });

  it("only logs on update error and never throws (best-effort)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = updatingDb({ error: { message: "down" } });
    await expect(
      linkTenantMailboxInboundRun("biz", "log-1", linkage, db as never)
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith("linkTenantMailboxInboundRun", "down");

    defaultClientSpy.mockRejectedValueOnce(new Error("no env"));
    await expect(linkTenantMailboxInboundRun("biz", "log-1", linkage)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith("linkTenantMailboxInboundRun", "no env");
    defaultClientSpy.mockRejectedValueOnce("weird");
    await expect(linkTenantMailboxInboundRun("biz", "log-1", linkage)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith("linkTenantMailboxInboundRun", "weird");
    errSpy.mockRestore();
  });

  it("uses the default service client when none is injected", async () => {
    const { update, db } = updatingDb({ error: null });
    defaultClientSpy.mockResolvedValueOnce(db);
    await linkTenantMailboxInboundRun("biz", "log-1", linkage);
    expect(update).toHaveBeenCalled();
  });
});

describe("recordOutboundAssistantEmail", () => {
  const input = {
    businessId: "biz",
    toEmail: "lead@example.com",
    subject: "Following up",
    bodyText: "y".repeat(600),
    source: "dashboard_chat" as const,
    fromEmail: "owner@biz.com",
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
        // The sending mailbox address, threaded in from the send result so
        // the Emails pane can show WHO sent it instead of a dash.
        from_email: "owner@biz.com",
        subject: "Following up",
        body_preview: "y".repeat(500),
        run_id: null,
        flow_id: null,
        provider_message_id: "gm-1"
      })
    );
  });

  it("stores a null from_email when the connection metadata had no address", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const db = { from: vi.fn(() => ({ insert })) };
    await recordOutboundAssistantEmail({ ...input, fromEmail: null }, db as never);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ from_email: null }));
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

describe("softDeleteEmailLogEntry", () => {
  it("delegates to the residency-aware soft delete with an id filter", async () => {
    vi.mocked(softDeleteContentRows).mockResolvedValue({ central: 1, box: null });
    const db = { from: vi.fn() };
    expect(await softDeleteEmailLogEntry("biz", "e1", "user-1", db as never)).toBe(1);
    expect(softDeleteContentRows).toHaveBeenCalledWith(
      "biz",
      "email_log",
      [{ column: "id", op: "eq", value: "e1" }],
      "user-1",
      { client: db }
    );
  });

  it("counts box-only stamps (vps-mode purged central) and defaults deps", async () => {
    vi.mocked(softDeleteContentRows).mockResolvedValue({ central: 0, box: 2 });
    expect(await softDeleteEmailLogEntry("biz", "e1", null)).toBe(2);
    expect(softDeleteContentRows).toHaveBeenCalledWith(
      "biz",
      "email_log",
      [{ column: "id", op: "eq", value: "e1" }],
      null,
      {}
    );
  });
});

