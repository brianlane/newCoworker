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
// The graph box re-projection pulls SSH/Hostinger machinery; mock the module
// boundary so unit tests stay hermetic. Individual tests inject deps.syncVault
// where they need behavior; this mock backs the default-dep path.
vi.mock("@/lib/vps/sync-vault", () => ({
  syncVaultToVps: vi.fn()
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
import { syncVaultToVps } from "@/lib/vps/sync-vault";
import { logger } from "@/lib/logger";

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
function makeCentralDb(
  perCall: Partial<Record<string, TableResult>> = {},
  storageRemove = vi.fn().mockResolvedValue({ error: null })
) {
  const seen = new Map<string, number>();
  const from = vi.fn((table: string) => {
    const n = (seen.get(table) ?? 0) + 1;
    seen.set(table, n);
    const result = perCall[`${table}#${n}`] ?? perCall[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    for (const m of ["delete", "update", "select", "eq", "lt", "in", "not", "neq", "contains", "ilike", "or", "order", "range"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return chain;
  });
  return { from, storage: { from: vi.fn(() => ({ remove: storageRemove })) }, storageRemove };
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
  vi.mocked(syncVaultToVps).mockResolvedValue({
    ok: true,
    hostingerVpsId: "h-1",
    publicIp: "203.0.113.9",
    projectId: BIZ,
    instructionsLength: 10
  });
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

describe("deleteEndUserData, central-only tenants", () => {
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

  it("scrubs the KG comparison ledger on every identifier axis (phone patterns × text columns)", async () => {
    const db = makeCentralDb({
      // 1 linked number × 4 text columns = 4 delete calls; give each a row.
      "kg_retrieval_events#1": { data: [{ id: "k1" }], error: null },
      "kg_retrieval_events#2": { data: [{ id: "k2" }], error: null },
      "kg_retrieval_events#3": { data: [], error: null },
      "kg_retrieval_events#4": { data: [{ id: "k3" }], error: null }
    });
    const res = await deleteEndUserData(BIZ, { e164: E164 }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.kg_retrieval_events).toEqual({
      table: "kg_retrieval_events",
      central: 3,
      box: null
    });
  });

  it("fails loudly when the KG ledger scrub errors", async () => {
    const db = makeCentralDb({
      kg_retrieval_events: { data: null, error: { message: "denied" } }
    });
    await expect(
      deleteEndUserData(BIZ, { e164: E164 }, { client: db as never })
    ).rejects.toThrow(/kg_retrieval_events: denied/);
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
      "unowned_lead_alerts",
      "scheduled_sms",
      "sms_owner_reply_prompts",
      "voice_call_transcripts",
      "email_log",
      "business_document_shares",
      "document_signature_requests",
      "ai_reply_reasoning",
      "sms_links",
      "ai_flow_notify_cooldowns",
      "kg_retrieval_events",
      "sms_inbound_jobs",
      "missed_call_autotexts",
      "meta_capi_events",
      "voice_handoff_sessions",
      "webchat_sessions",
      "messenger_conversations",
      "memory_entities",
      "memory_facts",
      "coworker_logs",
      "ai_flow_runs",
      "lead_submissions",
      "booking_waitlist",
      "calendar_booking_dedupe",
      "email_coworker_threads",
      "email_campaign_recipients",
      "outreach_prospects"
    ]);
  });

  it("deletes unsigned signature requests but only REDACTS signed ones (legal evidence)", async () => {
    const db = makeCentralDb({
      // Phone axis: #1 = delete unsigned, #2 = redact signed.
      "document_signature_requests#1": { data: [{ id: "r1" }], error: null },
      "document_signature_requests#2": { data: [{ id: "r2" }, { id: "r3" }], error: null },
      // Email axis: #3 = delete unsigned, #4 = redact signed.
      "document_signature_requests#3": { data: [], error: null },
      "document_signature_requests#4": { data: [{ id: "r4" }], error: null }
    });
    const res = await deleteEndUserData(
      BIZ,
      { e164: E164, email: EMAIL },
      { client: db as never }
    );
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.document_signature_requests).toEqual({
      table: "document_signature_requests",
      central: 4,
      box: null
    });
  });

  it("erases document share links keyed to the person's numbers AND email", async () => {
    const db = makeCentralDb({
      "business_document_shares#1": { data: [{ id: "s1" }], error: null },
      "business_document_shares#2": { data: [{ id: "s2" }, { id: "s3" }], error: null }
    });
    const res = await deleteEndUserData(
      BIZ,
      { e164: E164, email: EMAIL },
      { client: db as never }
    );
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.business_document_shares).toEqual({
      table: "business_document_shares",
      central: 3,
      box: null
    });
  });

  it("erases the person's AI reasoning records centrally across every linked number", async () => {
    const db = makeCentralDb({
      // The pre-delete scan reports a merge alias, reasoning stored under
      // it must be erased too (the .in() spans primary + aliases). Malformed
      // alias payloads (non-array, non-string/empty entries) are tolerated.
      "contacts#1": {
        data: [
          { customer_e164: E164, alias_e164s: ["+15550008888", "", 7] },
          { customer_e164: "+15550007777", alias_e164s: "junk" }
        ],
        error: null
      },
      ai_reply_reasoning: { data: [{ id: "r1" }, { id: "r2" }], error: null },
      sms_links: { data: [{ id: "l1" }], error: null },
      ai_flow_notify_cooldowns: { data: [{ business_id: BIZ }], error: null }
    });
    const res = await deleteEndUserData(BIZ, { e164: E164 }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.ai_reply_reasoning).toEqual({
      table: "ai_reply_reasoning",
      central: 2,
      box: null
    });
    // Tracked short links sent to any linked number are erased too
    // (central-only by design, see residency/tables.ts).
    expect(byTable.sms_links).toEqual({ table: "sms_links", central: 1, box: null });
    // A notify_owner cooldown keyed on {{vars.lead_phone}} is a row keyed to
    // the person, so it goes with them.
    expect(byTable.ai_flow_notify_cooldowns).toEqual({
      table: "ai_flow_notify_cooldowns",
      central: 1,
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
    // A contact-less email erasure has no numbers → no reasoning/link pass.
    const none = makeCentralDb({});
    const res2 = await deleteEndUserData(BIZ, { email: EMAIL }, { client: none as never });
    expect(res2.tables.some((t) => t.table === "ai_reply_reasoning")).toBe(false);
    expect(res2.tables.some((t) => t.table === "sms_links")).toBe(false);
  });

  it.each([
    ["contacts#1", /contacts \(linked-number scan\): boom/, { e164: E164 }],
    ["contacts#2", /contacts \(e164\): boom/, { e164: E164 }],
    ["contacts#3", /contacts \(alias\): boom/, { e164: E164 }],
    ["contacts#1", /contacts \(linked-number scan, email\): boom/, { email: EMAIL }],
    ["contacts#2", /contacts \(email\): boom/, { email: EMAIL }],
    ["sms_rowboat_threads", /sms_rowboat_threads: boom/, { e164: E164 }],
    ["sms_outbound_log", /sms_outbound_log: boom/, { e164: E164 }],
    ["unowned_lead_alerts", /unowned_lead_alerts: boom/, { e164: E164 }],
    ["scheduled_sms", /scheduled_sms: boom/, { e164: E164 }],
    ["ai_reply_reasoning", /ai_reply_reasoning: boom/, { e164: E164 }],
    ["business_document_shares", /business_document_shares: boom/, { e164: E164 }],
    ["business_document_shares", /business_document_shares: boom/, { email: EMAIL }],
    ["document_signature_requests#1", /document_signature_requests: boom/, { e164: E164 }],
    ["document_signature_requests#2", /document_signature_requests: boom/, { e164: E164 }],
    ["document_signature_requests#1", /document_signature_requests: boom/, { email: EMAIL }],
    ["document_signature_requests#2", /document_signature_requests: boom/, { email: EMAIL }],
    ["sms_links", /sms_links: boom/, { e164: E164 }],
    ["ai_flow_notify_cooldowns", /ai_flow_notify_cooldowns: boom/, { e164: E164 }],
    ["sms_owner_reply_prompts", /sms_owner_reply_prompts: boom/, { e164: E164 }],
    ["voice_call_transcripts", /voice_call_transcripts: boom/, { e164: E164 }],
    ["email_log#1", /email_log \(to\): boom/, { email: EMAIL }],
    ["email_log#2", /email_log \(from\): boom/, { email: EMAIL }],
    ["sms_inbound_jobs#1", /sms_inbound_jobs \(customer_e164\): boom/, { e164: E164 }],
    ["sms_inbound_jobs#2", /sms_inbound_jobs \(payload\): boom/, { e164: E164 }],
    ["missed_call_autotexts", /missed_call_autotexts: boom/, { e164: E164 }],
    ["meta_capi_events", /meta_capi_events: boom/, { e164: E164 }],
    ["voice_handoff_sessions#1", /voice_handoff_sessions \(from\): boom/, { e164: E164 }],
    ["voice_handoff_sessions#2", /voice_handoff_sessions \(chain\): boom/, { e164: E164 }],
    ["webchat_sessions#1", /webchat_sessions \(scan\): boom/, { e164: E164 }],
    ["messenger_conversations#1", /messenger_conversations \(scan\): boom/, { e164: E164 }],
    ["memory_entities#1", /memory_entities \(scan\): boom/, { e164: E164 }],
    ["memory_facts#1", /memory_facts: boom/, { e164: E164 }],
    ["memory_facts#2", /memory_facts: boom/, { e164: E164 }],
    ["memory_facts#2", /memory_facts: boom/, { e164: E164, email: EMAIL }],
    ["coworker_logs#1", /coworker_logs \(scan\): boom/, { e164: E164 }],
    ["ai_flow_runs#1", /ai_flow_runs \(scan\): boom/, { e164: E164 }],
    ["lead_submissions#1", /lead_submissions \(phone\): boom/, { e164: E164 }],
    ["lead_submissions#1", /lead_submissions \(email\): boom/, { email: EMAIL }],
    ["lead_submissions#2", /lead_submissions \(scan\): boom/, { e164: E164 }],
    ["booking_waitlist#1", /booking_waitlist \(phone\): boom/, { e164: E164 }],
    ["booking_waitlist#1", /booking_waitlist \(email\): boom/, { email: EMAIL }],
    ["calendar_booking_dedupe#1", /calendar_booking_dedupe \(key\): boom/, { e164: E164 }],
    ["calendar_booking_dedupe#1", /calendar_booking_dedupe \(key\): boom/, { email: EMAIL }],
    ["calendar_booking_dedupe#2", /calendar_booking_dedupe \(email\): boom/, { email: EMAIL }],
    ["email_coworker_threads", /email_coworker_threads: boom/, { email: EMAIL }],
    ["email_campaign_recipients", /email_campaign_recipients: boom/, { email: EMAIL }],
    ["outreach_prospects#1", /outreach_prospects \(email\): boom/, { email: EMAIL }],
    ["outreach_prospects#1", /outreach_prospects \(scan\): boom/, { e164: E164 }]
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

describe("deleteEndUserData, residency (dual/vps) tenants", () => {
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

describe("deleteEndUserData, expanded coverage stores", () => {
  const ERR = { data: null, error: { message: "boom" } };

  it("webchat: matches raw phone spellings + emails across pages, deletes by id", async () => {
    // Page 1 is exactly the page size (forces page 2); the raw-spelling
    // match sits on page 1, the email match on page 2. Junk rows exercise
    // the non-match branches (short digits, non-string phone, wrong email).
    const filler = Array.from({ length: 497 }, (_, i) => ({
      id: `w-f${i}`,
      visitor_phone: "+19998887777",
      visitor_email: "other@example.com"
    }));
    const page1 = [
      { id: "w-raw", visitor_phone: "(555) 123-4567", visitor_email: null },
      { id: "w-short", visitor_phone: "12345", visitor_email: null },
      { id: "w-nonstr", visitor_phone: 42, visitor_email: 42 },
      ...filler
    ];
    const page2 = [{ id: "w-mail", visitor_phone: null, visitor_email: " Person@Example.com " }];
    const db = makeCentralDb({
      "webchat_sessions#1": { data: page1, error: null },
      "webchat_sessions#2": { data: page2, error: null },
      "webchat_sessions#3": { data: [{ id: "w-raw" }, { id: "w-mail" }], error: null }
    });
    const res = await deleteEndUserData(BIZ, { e164: E164, email: EMAIL }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.webchat_sessions).toEqual({ table: "webchat_sessions", central: 2, box: null });
  });

  it("messenger: raw contact_phone and WhatsApp wa_id match; opaque psids never do", async () => {
    const db = makeCentralDb({
      "messenger_conversations#1": {
        data: [
          { id: "m-wa", platform: "whatsapp", psid: "15551234567", contact_phone: null },
          { id: "m-fb", platform: "messenger", psid: "15551234567", contact_phone: null },
          { id: "m-raw", platform: "instagram", psid: "opaque-9", contact_phone: "555.123.4567" },
          { id: "m-none", platform: "whatsapp", psid: "19998887777", contact_phone: null }
        ],
        error: null
      },
      "messenger_conversations#2": { data: [{ id: "m-wa" }, { id: "m-raw" }], error: null }
    });
    const res = await deleteEndUserData(BIZ, { e164: E164 }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.messenger_conversations).toEqual({
      table: "messenger_conversations",
      central: 2,
      box: null
    });
  });

  it("memory graph: every entity match axis works, facts scrub counts, box re-projects once", async () => {
    const db = makeCentralDb({
      "memory_entities#1": {
        data: [
          { id: "e-phone", phones: ["555-123-4567"], emails: [], customer_e164: null },
          { id: "e-mail", phones: [], emails: ["person@example.com"], customer_e164: null },
          { id: "e-cust", phones: [], emails: [], customer_e164: E164 },
          { id: "e-attr-p", phones: [], emails: [], customer_e164: null, attributed_to: E164 },
          { id: "e-attr-m", phones: "junk", emails: "junk", attributed_to: "person@example.com" },
          { id: "e-none", phones: ["+19998887777"], emails: ["other@example.com"], customer_e164: "+19998887777" }
        ],
        error: null
      },
      "memory_entities#2": {
        data: [{ id: "e-phone" }, { id: "e-mail" }, { id: "e-cust" }, { id: "e-attr-p" }, { id: "e-attr-m" }],
        error: null
      },
      "memory_facts#1": { data: [{ id: "f-attr" }], error: null },
      "memory_facts#3": { data: [{ id: "f-text" }], error: null }
    });
    const res = await deleteEndUserData(BIZ, { e164: E164, email: EMAIL }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.memory_entities).toEqual({ table: "memory_entities", central: 5, box: null });
    expect(byTable.memory_facts).toEqual({ table: "memory_facts", central: 2, box: null });
    expect(vi.mocked(syncVaultToVps)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(syncVaultToVps)).toHaveBeenCalledWith(BIZ);
  });

  it("a phone-only erasure follows the contact's email one hop into email-keyed stores", async () => {
    const db = makeCentralDb({
      // The linked-number scan also carries the contact's email address.
      "contacts#1": {
        data: [{ customer_e164: E164, alias_e164s: [], email: " Linked@Example.com " }],
        error: null
      },
      "email_log#1": { data: [{ id: "e1" }], error: null },
      "email_log#2": { data: [{ id: "e2" }], error: null },
      email_coworker_threads: { data: [{ id: "t1" }], error: null },
      email_campaign_recipients: { data: [{ id: "cr1" }], error: null },
      "webchat_sessions#1": {
        data: [{ id: "w1", visitor_phone: null, visitor_email: "linked@example.com" }],
        error: null
      },
      "webchat_sessions#2": { data: [{ id: "w1" }], error: null }
    });
    const res = await deleteEndUserData(BIZ, { e164: E164 }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.email_log).toEqual({ table: "email_log", central: 2, box: null });
    expect(byTable.email_coworker_threads.central).toBe(1);
    expect(byTable.email_campaign_recipients.central).toBe(1);
    expect(byTable.webchat_sessions.central).toBe(1);
  });

  it("attributed_to email matching is a case-insensitive escaped ilike, not a case-sensitive in()", async () => {
    const db = makeCentralDb({
      "memory_facts#1": { data: [{ id: "f-num" }], error: null },
      "memory_facts#2": { data: [{ id: "f-mail" }], error: null }
    });
    const res = await deleteEndUserData(
      BIZ,
      { e164: E164, email: "Jo_hn@Example.com" },
      { client: db as never }
    );
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.memory_facts.central).toBe(2);
    // Inspect the second memory_facts round trip: the email attribution
    // delete must use ilike with the ESCAPED lowercased literal.
    const factChains = db.from.mock.calls
      .map((c, i) => [c[0], db.from.mock.results[i].value] as const)
      .filter(([t]) => t === "memory_facts")
      .map(([, ch]) => ch as { ilike: ReturnType<typeof vi.fn>; in: ReturnType<typeof vi.fn> });
    expect(factChains[0].in).toHaveBeenCalledWith("attributed_to", [E164]);
    expect(factChains[1].ilike).toHaveBeenCalledWith("attributed_to", "jo\\_hn@example.com");
  });

  it("a null scan page counts as empty and ends the pagination", async () => {
    const db = makeCentralDb({ "webchat_sessions#1": { data: null, error: null } });
    const res = await deleteEndUserData(BIZ, { e164: E164 }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.webchat_sessions).toEqual({ table: "webchat_sessions", central: 0, box: null });
  });

  it("box re-projection is skipped when the graph had nothing to erase", async () => {
    const db = makeCentralDb();
    await deleteEndUserData(BIZ, { e164: E164 }, { client: db as never });
    expect(vi.mocked(syncVaultToVps)).not.toHaveBeenCalled();
  });

  it("box re-projection tolerates a tenant with no box, and honors an injected dep", async () => {
    const perCall = {
      "memory_facts#1": { data: [{ id: "f-1" }], error: null }
    };
    const injected = vi
      .fn()
      .mockResolvedValue({ ok: false as const, reason: "no_vps_assigned" as const });
    await deleteEndUserData(
      BIZ,
      { e164: E164 },
      { client: makeCentralDb(perCall) as never, syncVault: injected }
    );
    expect(injected).toHaveBeenCalledWith(BIZ);
    expect(vi.mocked(syncVaultToVps)).not.toHaveBeenCalled();
  });

  it("box re-projection failure is LOUD, with and without detail", async () => {
    const perCall = {
      "memory_facts#1": { data: [{ id: "f-1" }], error: null }
    };
    await expect(
      deleteEndUserData(
        BIZ,
        { e164: E164 },
        {
          client: makeCentralDb(perCall) as never,
          syncVault: vi.fn().mockResolvedValue({
            ok: false as const,
            reason: "ssh_failed" as const,
            detail: "tunnel down"
          })
        }
      )
    ).rejects.toThrow(/memory graph box re-sync failed: ssh_failed \(tunnel down\)/);
    await expect(
      deleteEndUserData(
        BIZ,
        { e164: E164 },
        {
          client: makeCentralDb(perCall) as never,
          syncVault: vi.fn().mockResolvedValue({ ok: false as const, reason: "no_ssh_key" as const })
        }
      )
    ).rejects.toThrow(/memory graph box re-sync failed: no_ssh_key$/);
  });

  it("coworker_logs: matches every writer key vocabulary, skips junk payloads", async () => {
    const db = makeCentralDb({
      "coworker_logs#1": {
        data: [
          { id: "l-wp", log_payload: { visitorPhone: "(555) 123-4567" } },
          { id: "l-lp", log_payload: { leadPhone: "5551234567" } },
          { id: "l-cp", log_payload: { callerPhone: E164 } },
          { id: "l-we", log_payload: { visitorEmail: "PERSON@example.com" } },
          { id: "l-le", log_payload: { leadEmail: "person@example.com" } },
          { id: "l-ce", log_payload: { callerEmail: " person@example.com " } },
          // The SMS notify-team twin (task_type 'sms') stores the texter as
          // customerPhone, E.164-coerced when possible, raw otherwise.
          { id: "l-sp", log_payload: { source: "sms_tool_notify_team", customerPhone: "612-555-1234567" } },
          { id: "l-null", log_payload: null },
          { id: "l-none", log_payload: { note: "unrelated", callerPhone: "+19998887777" } }
        ],
        error: null
      },
      "coworker_logs#2": {
        data: [
          { id: "l-wp" },
          { id: "l-lp" },
          { id: "l-cp" },
          { id: "l-we" },
          { id: "l-le" },
          { id: "l-ce" },
          { id: "l-sp" }
        ],
        error: null
      }
    });
    const res = await deleteEndUserData(BIZ, { e164: E164, email: EMAIL }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.coworker_logs).toEqual({ table: "coworker_logs", central: 7, box: null });
  });

  it("ai_flow_runs: nested context values match by digits, email, and number type", async () => {
    const db = makeCentralDb({
      // A junk short-digit alias lands in the linked set and must be ignored
      // by the substring matcher (form shorter than 7 digits).
      "contacts#1": {
        data: [{ customer_e164: E164, alias_e164s: ["77"] }],
        error: null
      },
      "ai_flow_runs#1": {
        data: [
          { id: "r-nest", context: { lead: { phone: "555-123-4567" } } },
          { id: "r-arr", context: { answers: ["call +1 555 123 4567 later"] } },
          { id: "r-num", context: { n: 15551234567 } },
          { id: "r-mail", context: { note: "reach Person@Example.com" } },
          { id: "r-none", context: { note: "hello", nested: { x: ["nothing"] } } },
          { id: "r-otherphone", context: { other: "+1 999 888 7766" } },
          { id: "r-null", context: null }
        ],
        error: null
      },
      "ai_flow_runs#2": {
        data: [{ id: "r-nest" }, { id: "r-arr" }, { id: "r-num" }, { id: "r-mail" }],
        error: null
      }
    });
    const res = await deleteEndUserData(BIZ, { e164: E164, email: EMAIL }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.ai_flow_runs).toEqual({ table: "ai_flow_runs", central: 4, box: null });
  });

  it("lead_submissions: indexed deletes plus the residual fields scan", async () => {
    const db = makeCentralDb({
      "lead_submissions#1": { data: [{ id: "s-p" }], error: null },
      "lead_submissions#2": { data: [{ id: "s-e" }], error: null },
      "lead_submissions#3": {
        data: [
          { id: "s-raw", fields: { "Best number": "555 123 4567" } },
          { id: "s-none", fields: { color: "blue" } }
        ],
        error: null
      },
      "lead_submissions#4": { data: [{ id: "s-raw" }], error: null }
    });
    const res = await deleteEndUserData(BIZ, { e164: E164, email: EMAIL }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.lead_submissions).toEqual({ table: "lead_submissions", central: 3, box: null });
  });

  it("phone-gated stores run on the phone axis and email-gated stores stay out", async () => {
    const db = makeCentralDb({
      "sms_inbound_jobs#1": { data: [{ id: "j1" }], error: null },
      "sms_inbound_jobs#2": { data: [{ id: "j2" }], error: null },
      missed_call_autotexts: { data: [{ id: "a1" }], error: null },
      meta_capi_events: { data: [{ id: "c1" }], error: null },
      "voice_handoff_sessions#1": { data: [{ call_control_id: "v1" }], error: null },
      "voice_handoff_sessions#2": { data: [{ call_control_id: "v2" }], error: null },
      "booking_waitlist#1": { data: [{ id: "b1" }], error: null },
      "calendar_booking_dedupe#1": { data: [{ id: "d1" }], error: null }
    });
    const res = await deleteEndUserData(BIZ, { e164: E164 }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.sms_inbound_jobs.central).toBe(2);
    expect(byTable.missed_call_autotexts.central).toBe(1);
    expect(byTable.meta_capi_events.central).toBe(1);
    expect(byTable.voice_handoff_sessions.central).toBe(2);
    expect(byTable.booking_waitlist.central).toBe(1);
    expect(byTable.calendar_booking_dedupe.central).toBe(1);
    expect(byTable.email_coworker_threads).toBeUndefined();
    expect(byTable.email_campaign_recipients).toBeUndefined();
  });

  it("email-gated stores run on the email axis and phone-gated stores stay out", async () => {
    const db = makeCentralDb({
      "calendar_booking_dedupe#1": { data: [{ id: "d-key" }], error: null },
      "calendar_booking_dedupe#2": { data: [{ id: "d-mail" }], error: null },
      email_coworker_threads: { data: [{ id: "t1" }], error: null },
      email_campaign_recipients: { data: [{ id: "cr1" }, { id: "cr2" }], error: null },
      "booking_waitlist#1": { data: [{ id: "b1" }], error: null }
    });
    const res = await deleteEndUserData(BIZ, { email: EMAIL }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.calendar_booking_dedupe.central).toBe(2);
    expect(byTable.email_coworker_threads.central).toBe(1);
    expect(byTable.email_campaign_recipients.central).toBe(2);
    expect(byTable.booking_waitlist.central).toBe(1);
    expect(byTable.sms_inbound_jobs).toBeUndefined();
    expect(byTable.missed_call_autotexts).toBeUndefined();
    expect(byTable.meta_capi_events).toBeUndefined();
    expect(byTable.voice_handoff_sessions).toBeUndefined();
    expect(byTable.messenger_conversations).toBeUndefined();
  });

  it("outreach: redacts on both axes instead of deleting, so suppression survives", async () => {
    const db = makeCentralDb({
      "outreach_prospects#1": { data: [{ id: "p-mail" }], error: null },
      "outreach_prospects#2": {
        data: [
          { id: "p-raw", phone: "555.123.4567" },
          { id: "p-none", phone: "+19998887777" }
        ],
        error: null
      },
      "outreach_prospects#3": { data: [{ id: "p-raw" }], error: null }
    });
    const res = await deleteEndUserData(BIZ, { e164: E164, email: EMAIL }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.outreach_prospects).toEqual({ table: "outreach_prospects", central: 2, box: null });
    // Three passes: email redaction, phone scan, phone redaction.
    expect(db.from.mock.calls.filter((c) => c[0] === "outreach_prospects")).toHaveLength(3);
  });

  it("email attachments: collected from BOTH deleted axes and removed from storage", async () => {
    const db = makeCentralDb({
      "email_log#1": {
        data: [
          {
            id: "e1",
            attachments: [{ storage_path: "inbound/m1/0-a.pdf" }, { storage_path: "" }, { storage_path: 7 }, "junk"]
          }
        ],
        error: null
      },
      "email_log#2": {
        data: [
          { id: "e2", attachments: [{ storage_path: "inbound/m2/0-b.png" }] },
          { id: "e3", attachments: "not-an-array" },
          { id: "e4" }
        ],
        error: null
      }
    });
    await deleteEndUserData(BIZ, { email: EMAIL }, { client: db as never });
    expect(db.storage.from).toHaveBeenCalledWith("email-attachments");
    expect(db.storageRemove).toHaveBeenCalledWith(["inbound/m1/0-a.pdf", "inbound/m2/0-b.png"]);
  });

  it("email attachments: storage remove failure warns but never throws", async () => {
    const storageRemove = vi.fn().mockResolvedValue({ error: { message: "bucket sad" } });
    const db = makeCentralDb(
      {
        "email_log#1": {
          data: [{ id: "e1", attachments: [{ storage_path: "inbound/m1/0-a.pdf" }] }],
          error: null
        }
      },
      storageRemove
    );
    const res = await deleteEndUserData(BIZ, { email: EMAIL }, { client: db as never });
    const byTable = Object.fromEntries(res.tables.map((t) => [t.table, t]));
    expect(byTable.email_log.central).toBe(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "deleteEndUserData: email-attachments storage remove failed",
      expect.objectContaining({ businessId: BIZ, objectCount: 1, error: "bucket sad" })
    );
  });

  it("email attachments: no storage round trip when deleted rows carried none", async () => {
    const db = makeCentralDb({
      "email_log#1": { data: [{ id: "e1", attachments: [] }], error: null }
    });
    await deleteEndUserData(BIZ, { email: EMAIL }, { client: db as never });
    expect(db.storage.from).not.toHaveBeenCalled();
  });

  it.each([
    [
      "webchat_sessions",
      {
        "webchat_sessions#1": { data: [{ id: "w1", visitor_phone: E164 }], error: null },
        "webchat_sessions#2": ERR
      },
      /webchat_sessions: boom/
    ],
    [
      "messenger_conversations",
      {
        "messenger_conversations#1": {
          data: [{ id: "m1", platform: "whatsapp", psid: "15551234567" }],
          error: null
        },
        "messenger_conversations#2": ERR
      },
      /messenger_conversations: boom/
    ],
    [
      "memory_entities",
      {
        "memory_entities#1": { data: [{ id: "e1", customer_e164: E164 }], error: null },
        "memory_entities#2": ERR
      },
      /memory_entities: boom/
    ],
    [
      "coworker_logs",
      {
        "coworker_logs#1": { data: [{ id: "l1", log_payload: { callerPhone: E164 } }], error: null },
        "coworker_logs#2": ERR
      },
      /coworker_logs: boom/
    ],
    [
      "ai_flow_runs",
      {
        "ai_flow_runs#1": { data: [{ id: "r1", context: { p: E164 } }], error: null },
        "ai_flow_runs#2": ERR
      },
      /ai_flow_runs: boom/
    ],
    [
      "lead_submissions",
      {
        "lead_submissions#2": { data: [{ id: "s1", fields: { p: E164 } }], error: null },
        "lead_submissions#3": ERR
      },
      /lead_submissions \(residual\): boom/
    ],
    [
      "outreach_prospects",
      {
        "outreach_prospects#1": { data: [{ id: "p1", phone: E164 }], error: null },
        "outreach_prospects#2": ERR
      },
      /outreach_prospects \(phone\): boom/
    ]
  ] as Array<[string, Record<string, TableResult>, RegExp]>)(
    "delete-after-scan failure on %s throws the typed error",
    async (_table, perCall, pattern) => {
      const db = makeCentralDb(perCall);
      await expect(
        deleteEndUserData(BIZ, { e164: E164 }, { client: db as never })
      ).rejects.toThrow(pattern);
    }
  );
});
