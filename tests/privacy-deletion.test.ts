import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/residency/read", () => ({
  residencyModeFor: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  EndUserDeletionError,
  deleteEndUserData,
  escapeLikeLiteral,
  fingerprintIdentifier,
  normalizeEndUserIdentifier
} from "@/lib/privacy/deletion";
import { residencyModeFor } from "@/lib/residency/read";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "biz-1";
const E164 = "+15551234567";
const EMAIL = "Person@Example.com";

type TableResult = { data: unknown; error: { message: string } | null };

/**
 * Chainable central-db stub. `perCall` maps "<table>#<n>" (n = 1-based call
 * index per table) or "<table>" to a result, so tests can fail a SPECIFIC
 * operation on tables the module hits more than once (contacts, email_log).
 * The chain is THENABLE (one from() = one awaited result) so both shapes
 * work: mutation chains ending in .select() and select-first reads like the
 * linked-number scan.
 */
function makeCentralDb(perCall: Partial<Record<string, TableResult>> = {}) {
  const seen = new Map<string, number>();
  const from = vi.fn((table: string) => {
    const n = (seen.get(table) ?? 0) + 1;
    seen.set(table, n);
    const result = perCall[`${table}#${n}`] ?? perCall[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    for (const m of ["delete", "select", "eq", "lt", "in", "not", "contains", "ilike", "or"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return chain;
  });
  return { from };
}

function makeApi(overrides: Partial<{ select: unknown; delete: unknown }> = {}) {
  return {
    select: (overrides.select ?? vi.fn().mockResolvedValue({ ok: true, rows: [] })) as never,
    delete: (overrides.delete ?? vi.fn().mockResolvedValue({ ok: true, rows: [] })) as never
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(residencyModeFor).mockResolvedValue("supabase");
});

describe("normalizeEndUserIdentifier / fingerprintIdentifier", () => {
  it("requires at least one identifier", () => {
    expect(() => normalizeEndUserIdentifier({})).toThrow(EndUserDeletionError);
    expect(() => normalizeEndUserIdentifier({ e164: "  ", email: "" })).toThrow(
      /Provide an E.164/
    );
  });

  it("validates E.164 and email shapes", () => {
    expect(() => normalizeEndUserIdentifier({ e164: "555-1234" })).toThrow(/valid E.164/);
    expect(() => normalizeEndUserIdentifier({ email: "not-an-email" })).toThrow(/valid email/);
  });

  it("normalizes (trim, lowercase email)", () => {
    expect(normalizeEndUserIdentifier({ e164: ` ${E164} `, email: ` ${EMAIL} ` })).toEqual({
      e164: E164,
      email: "person@example.com"
    });
  });

  it("escapeLikeLiteral neutralizes ILIKE metacharacters", () => {
    expect(escapeLikeLiteral("jo_hn%doe\\x@a.co")).toBe("jo\\_hn\\%doe\\\\x@a.co");
    expect(escapeLikeLiteral("plain@a.co")).toBe("plain@a.co");
  });

  it("fingerprint is the sha256 of the normalized pair", () => {
    expect(fingerprintIdentifier(E164, "a@b.co")).toBe(
      createHash("sha256").update(`${E164}|a@b.co`).digest("hex")
    );
    expect(fingerprintIdentifier(null, "a@b.co")).toBe(
      createHash("sha256").update("|a@b.co").digest("hex")
    );
  });
});

describe("deleteEndUserData — central-only tenants", () => {
  it("deletes phone-keyed + contact rows for an e164-only request", async () => {
    const db = makeCentralDb({
      // contacts#1 is the linked-number scan (aliases captured pre-delete);
      // a null page is treated as empty.
      "contacts#1": { data: null, error: null },
      "contacts#2": { data: [{ id: "c1" }], error: null },
      "contacts#3": { data: [{ id: "c2" }], error: null },
      sms_rowboat_threads: { data: [{ business_id: BIZ }], error: null },
      voice_call_transcripts: { data: [{ id: "t1" }, { id: "t2" }], error: null }
    });
    const res = await deleteEndUserData(BIZ, { e164: E164 }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.contacts).toEqual({ table: "contacts", central: 2, box: null });
    expect(byTable.sms_rowboat_threads.central).toBe(1);
    expect(byTable.voice_call_transcripts.central).toBe(2);
    // No email identifier → no email_log entry.
    expect(byTable.email_log).toBeUndefined();
    expect(res.identifierFingerprint).toBe(fingerprintIdentifier(E164, null));
  });

  it("deletes email-keyed rows (to + from) for an email-only request", async () => {
    const db = makeCentralDb({
      "email_log#1": { data: [{ id: "e1" }], error: null },
      "email_log#2": { data: [{ id: "e2" }, { id: "e3" }], error: null }
    });
    const res = await deleteEndUserData(BIZ, { email: EMAIL }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.email_log.central).toBe(3);
    // No phone identifier → no SMS/voice passes.
    expect(byTable.sms_rowboat_threads).toBeUndefined();
    expect(res.identifierFingerprint).toBe(fingerprintIdentifier(null, "person@example.com"));
  });

  it("covers both identifier axes in one request", async () => {
    const db = makeCentralDb();
    const res = await deleteEndUserData(
      BIZ,
      { e164: E164, email: EMAIL },
      { client: db as never }
    );
    const tables = res.tables.map((t) => t.table);
    expect(tables).toEqual([
      "contacts",
      "sms_rowboat_threads",
      "sms_outbound_log",
      "scheduled_sms",
      "sms_owner_reply_prompts",
      "voice_call_transcripts",
      "email_log",
      "ai_reply_reasoning"
    ]);
  });

  it("erases the person's AI reasoning records centrally across every linked number", async () => {
    const db = makeCentralDb({
      // The pre-delete scan reports a merge alias — reasoning stored under
      // it must be erased too (the .in() spans primary + aliases). Malformed
      // alias payloads (non-array, non-string/empty entries) are tolerated.
      "contacts#1": {
        data: [
          { customer_e164: E164, alias_e164s: ["+15550008888", "", 7] },
          { customer_e164: "+15550007777", alias_e164s: "junk" }
        ],
        error: null
      },
      ai_reply_reasoning: { data: [{ id: "r1" }, { id: "r2" }], error: null }
    });
    const res = await deleteEndUserData(BIZ, { e164: E164 }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.ai_reply_reasoning).toEqual({
      table: "ai_reply_reasoning",
      central: 2,
      box: null
    });
  });

  it("an EMAIL-ONLY erasure still deletes reasoning through the contact's numbers", async () => {
    const db = makeCentralDb({
      // contacts#1 = the email-axis linked-number scan; #2 = the email delete.
      "contacts#1": {
        data: [{ customer_e164: E164, alias_e164s: ["+15550008888"] }],
        error: null
      },
      "contacts#2": { data: [{ id: "c1" }], error: null },
      ai_reply_reasoning: { data: [{ id: "r1" }], error: null }
    });
    const res = await deleteEndUserData(BIZ, { email: EMAIL }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.ai_reply_reasoning).toEqual({
      table: "ai_reply_reasoning",
      central: 1,
      box: null
    });
    // A contact-less email erasure has no numbers → no reasoning pass.
    const none = makeCentralDb({});
    const res2 = await deleteEndUserData(BIZ, { email: EMAIL }, { client: none as never });
    expect(res2.tables.some((t) => t.table === "ai_reply_reasoning")).toBe(false);
  });

  it.each([
    ["contacts#1", /contacts \(linked-number scan\): boom/, { e164: E164 }],
    ["contacts#2", /contacts \(e164\): boom/, { e164: E164 }],
    ["contacts#3", /contacts \(alias\): boom/, { e164: E164 }],
    ["contacts#1", /contacts \(linked-number scan, email\): boom/, { email: EMAIL }],
    ["contacts#2", /contacts \(email\): boom/, { email: EMAIL }],
    ["sms_rowboat_threads", /sms_rowboat_threads: boom/, { e164: E164 }],
    ["sms_outbound_log", /sms_outbound_log: boom/, { e164: E164 }],
    ["scheduled_sms", /scheduled_sms: boom/, { e164: E164 }],
    ["ai_reply_reasoning", /ai_reply_reasoning: boom/, { e164: E164 }],
    ["sms_owner_reply_prompts", /sms_owner_reply_prompts: boom/, { e164: E164 }],
    ["voice_call_transcripts", /voice_call_transcripts: boom/, { e164: E164 }],
    ["email_log#1", /email_log \(to\): boom/, { email: EMAIL }],
    ["email_log#2", /email_log \(from\): boom/, { email: EMAIL }]
  ] as Array<[string, RegExp, { e164?: string; email?: string }]>)(
    "central failure on %s throws the typed error",
    async (key, pattern, ident) => {
      const db = makeCentralDb({ [key]: { data: null, error: { message: "boom" } } });
      await expect(deleteEndUserData(BIZ, ident, { client: db as never })).rejects.toThrow(
        pattern
      );
    }
  );

  it("uses the default service client when none is injected", async () => {
    const db = makeCentralDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await deleteEndUserData(BIZ, { e164: E164 });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("deleteEndUserData — residency (dual/vps) tenants", () => {
  it("also deletes on the box, turns-before-transcripts, and counts both", async () => {
    vi.mocked(residencyModeFor).mockResolvedValue("vps");
    const db = makeCentralDb();
    const apiSelect = vi.fn().mockResolvedValue({ ok: true, rows: [{ id: "t-9" }] });
    const calls: string[] = [];
    const apiDelete = vi.fn(async (req: { table: string }) => {
      calls.push(req.table);
      return { ok: true, rows: [{ id: "x" }] };
    });
    const res = await deleteEndUserData(
      BIZ,
      { e164: E164, email: EMAIL },
      { client: db as never, dataApiFor: () => makeApi({ select: apiSelect, delete: apiDelete }) }
    );
    // Turns delete precedes the transcripts delete.
    const turnsIdx = calls.indexOf("voice_call_transcript_turns");
    const transcriptIdx = calls.indexOf("voice_call_transcripts");
    expect(turnsIdx).toBeGreaterThanOrEqual(0);
    expect(turnsIdx).toBeLessThan(transcriptIdx);
    // Contacts got two box passes (e164 + email); email_log got to + from.
    expect(calls.filter((t) => t === "contacts")).toHaveLength(2);
    expect(calls.filter((t) => t === "email_log")).toHaveLength(2);
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.contacts.box).toBe(2);
    expect(byTable.email_log.box).toBe(2);
    expect(byTable.voice_call_transcripts.box).toBe(1);
  });

  it("erases box contacts matched only by alias_e164s (paged client-side scan)", async () => {
    vi.mocked(residencyModeFor).mockResolvedValue("vps");
    const db = makeCentralDb();
    // Page 1 is exactly the page size (forces a second fetch); the alias
    // match sits on page 2. Rows without an alias array exercise the
    // defensive Array.isArray branch.
    const page1 = Array.from({ length: 500 }, (_, i) => ({
      id: `c-${i}`,
      alias_e164s: ["+19998887777"]
    }));
    const page2 = [
      { id: "c-alias", alias_e164s: ["+12223334444", E164] },
      { id: "c-no-arr" }
    ];
    const apiSelect = vi.fn(async (req: { table: string; offset?: number }) => {
      if (req.table === "contacts") {
        return { ok: true, rows: req.offset === 0 ? page1 : page2 };
      }
      return { ok: true, rows: [] }; // transcripts select
    });
    const apiDelete = vi.fn().mockResolvedValue({ ok: true, rows: [{ id: "x" }] });
    await deleteEndUserData(
      BIZ,
      { e164: E164 },
      { client: db as never, dataApiFor: () => makeApi({ select: apiSelect, delete: apiDelete }) }
    );
    expect(apiSelect).toHaveBeenCalledWith(
      expect.objectContaining({ table: "contacts", offset: 0, limit: 500 })
    );
    expect(apiSelect).toHaveBeenCalledWith(
      expect.objectContaining({ table: "contacts", offset: 500, limit: 500 })
    );
    expect(apiDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        table: "contacts",
        filters: expect.arrayContaining([{ column: "id", op: "in", value: ["c-alias"] }])
      })
    );
  });

  it("fails loudly when the box contacts alias scan reports ok:false", async () => {
    vi.mocked(residencyModeFor).mockResolvedValue("vps");
    const apiSelect = vi.fn(async (req: { table: string }) =>
      req.table === "contacts"
        ? { ok: false, error: "internal", message: "scan sad" }
        : { ok: true, rows: [] }
    );
    await expect(
      deleteEndUserData(
        BIZ,
        { e164: E164 },
        {
          client: makeCentralDb() as never,
          dataApiFor: () => makeApi({ select: apiSelect })
        }
      )
    ).rejects.toThrow(/box select on contacts failed: scan sad/);
  });

  it("email-only residency request boxes only the email passes", async () => {
    vi.mocked(residencyModeFor).mockResolvedValue("vps");
    // Null data payloads (e.g. PostgREST returning no body) count as 0.
    const db = makeCentralDb({ "email_log#1": { data: null, error: null } });
    const apiDelete = vi.fn().mockResolvedValue({ ok: true, rows: [] });
    const res = await deleteEndUserData(
      BIZ,
      { email: EMAIL },
      { client: db as never, dataApiFor: () => makeApi({ delete: apiDelete }) }
    );
    const boxedTables = apiDelete.mock.calls.map((c) => (c[0] as { table: string }).table);
    expect(boxedTables).toEqual(["contacts", "email_log", "email_log"]);
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.email_log.central).toBe(0);
  });

  it("passes the ESCAPED literal to every ilike filter (no wildcard erasure)", async () => {
    vi.mocked(residencyModeFor).mockResolvedValue("vps");
    const apiDelete = vi.fn().mockResolvedValue({ ok: true, rows: [] });
    await deleteEndUserData(
      BIZ,
      { email: "jo_hn%doe@example.com" },
      { client: makeCentralDb() as never, dataApiFor: () => makeApi({ delete: apiDelete }) }
    );
    const emailFilters = apiDelete.mock.calls
      .flatMap((c) => (c[0] as { filters: Array<{ op: string; value: unknown }> }).filters)
      .filter((f) => f.op === "ilike");
    expect(emailFilters.length).toBeGreaterThan(0);
    for (const f of emailFilters) {
      expect(f.value).toBe("jo\\_hn\\%doe@example.com");
    }
  });

  it("skips the box turns pass when the person has no box transcripts", async () => {
    vi.mocked(residencyModeFor).mockResolvedValue("dual");
    const db = makeCentralDb();
    const apiDelete = vi.fn().mockResolvedValue({ ok: true, rows: [] });
    await deleteEndUserData(
      BIZ,
      { e164: E164 },
      { client: db as never, dataApiFor: () => makeApi({ delete: apiDelete }) }
    );
    expect(
      apiDelete.mock.calls.some(
        (c) => (c[0] as { table: string }).table === "voice_call_transcript_turns"
      )
    ).toBe(false);
  });

  it("fails loudly on box delete / select / turns-delete errors", async () => {
    vi.mocked(residencyModeFor).mockResolvedValue("vps");

    // Box delete on contacts fails.
    await expect(
      deleteEndUserData(
        BIZ,
        { e164: E164 },
        {
          client: makeCentralDb() as never,
          dataApiFor: () =>
            makeApi({
              delete: vi.fn().mockResolvedValue({ ok: false, error: "internal", message: "sad" })
            })
        }
      )
    ).rejects.toThrow(/box delete on contacts failed: sad/);

    // Box transcript select fails (the contacts alias scan succeeds first).
    await expect(
      deleteEndUserData(
        BIZ,
        { e164: E164 },
        {
          client: makeCentralDb() as never,
          dataApiFor: () =>
            makeApi({
              select: vi.fn(async (req: { table: string }) =>
                req.table === "voice_call_transcripts"
                  ? { ok: false, error: "internal", message: "sel sad" }
                  : { ok: true, rows: [] }
              )
            })
        }
      )
    ).rejects.toThrow(/box select on voice_call_transcripts failed: sel sad/);

    // Box turns delete fails.
    const apiSelect = vi.fn().mockResolvedValue({ ok: true, rows: [{ id: "t-1" }] });
    const apiDelete = vi.fn(async (req: { table: string }) =>
      req.table === "voice_call_transcript_turns"
        ? { ok: false, error: "internal", message: "turns sad" }
        : { ok: true, rows: [] }
    );
    await expect(
      deleteEndUserData(
        BIZ,
        { e164: E164 },
        {
          client: makeCentralDb() as never,
          dataApiFor: () => makeApi({ select: apiSelect, delete: apiDelete })
        }
      )
    ).rejects.toThrow(/box delete on voice_call_transcript_turns failed: turns sad/);
  });
});
