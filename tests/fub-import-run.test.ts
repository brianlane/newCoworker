import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai-flows/contact-event-hooks", () => ({ fireContactEvent: vi.fn() }));
vi.mock("@/lib/contacts/identity", () => ({ upsertContactIdentity: vi.fn() }));

import {
  createFubImportJob,
  dryRunFubImport,
  getFubImportJob,
  latestFubImportJob,
  normalizeFubCursor,
  normalizeFubRunCounts,
  runFubImportChunk,
  sanitizeFubError,
  toPublicFubImportJob,
  updateFubImportJob,
  wipeFubImportJobKey,
  type FubImportJobRow
} from "@/lib/fub-import/run";
import { upsertContactIdentity } from "@/lib/contacts/identity";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";
import type { FubClient, FubPage } from "@/lib/fub-import/client";

const BIZ = "00000000-0000-0000-0000-000000000001";
const JOB = "00000000-0000-0000-0000-00000000000a";

type CallLog = { name: string; args: unknown[] };
type Scripted = { data?: unknown; error?: unknown };

/**
 * Scripted PostgREST double, one result queue per table (results pop in call
 * order at each terminal await). fub_import_jobs falls back to a matched row
 * so per-page persists succeed without scripting each one.
 */
function makeDb(queues: Partial<Record<string, Scripted[]>> = {}) {
  const log: { table: string; calls: CallLog[] }[] = [];
  const state = new Map(Object.entries(queues).map(([k, v]) => [k, [...(v ?? [])]]));
  const next = (table: string): Scripted => {
    const queue = state.get(table);
    if (queue && queue.length > 0) return queue.shift() as Scripted;
    return table === "fub_import_jobs"
      ? { data: [{ id: JOB }], error: null }
      : { data: null, error: null };
  };
  const from = (table: string) => {
    const calls: CallLog[] = [];
    log.push({ table, calls });
    const builder: Record<string, unknown> = {};
    for (const m of [
      "select",
      "insert",
      "update",
      "delete",
      "upsert",
      "eq",
      "neq",
      "not",
      "or",
      "is",
      "in",
      "ilike",
      "order",
      "limit",
      "range"
    ]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ name: m, args });
        return builder;
      };
    }
    builder["maybeSingle"] = async () => {
      calls.push({ name: "maybeSingle", args: [] });
      return next(table);
    };
    builder["single"] = async () => {
      calls.push({ name: "single", args: [] });
      return next(table);
    };
    builder["then"] = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve);
    return builder;
  };
  return { db: { from } as never, log };
}

function emptyPage<T>(items: T[] = [], extra: Partial<FubPage<T>> = {}): FubPage<T> {
  return { items, total: null, next: null, ...extra };
}

function stubClient(overrides: Record<string, unknown> = {}): FubClient {
  return {
    ping: vi.fn(async () => ({ name: null })),
    getPeople: vi.fn(async () => emptyPage()),
    getPeopleByIds: vi.fn(async () => emptyPage()),
    getNotes: vi.fn(async () => emptyPage()),
    getDeals: vi.fn(async () => emptyPage()),
    getPipelines: vi.fn(async () => emptyPage()),
    getStages: vi.fn(async () => emptyPage()),
    getSmartLists: vi.fn(async () => emptyPage()),
    getActionPlans: vi.fn(async () => emptyPage()),
    ...overrides
  } as unknown as FubClient;
}

function jobRow(overrides: Partial<FubImportJobRow> = {}): FubImportJobRow {
  return {
    id: JOB,
    business_id: BIZ,
    status: "dry_run_done",
    dry_run: true,
    api_key_encrypted: "enc:v1:x",
    counts: {},
    cursor: {},
    error: null,
    created_by: null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
    ...overrides
  };
}

const upsertMock = vi.mocked(upsertContactIdentity);
const fireMock = vi.mocked(fireContactEvent);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("job rows", () => {
  it("createFubImportJob inserts, then wipes older keys", async () => {
    const row = jobRow();
    const { db, log } = makeDb({
      fub_import_jobs: [{ data: row, error: null }, { data: [], error: null }]
    });
    const created = await createFubImportJob(db, BIZ, "cipher", "user-1");
    expect(created).toEqual(row);
    expect(log[0].calls.find((c) => c.name === "insert")?.args[0]).toEqual({
      business_id: BIZ,
      api_key_encrypted: "cipher",
      created_by: "user-1"
    });
    const wipe = log[1].calls;
    expect(wipe.find((c) => c.name === "update")?.args[0]).toMatchObject({
      api_key_encrypted: null
    });
    expect(wipe.find((c) => c.name === "neq")?.args).toEqual(["id", JOB]);
    expect(wipe.find((c) => c.name === "not")?.args).toEqual(["api_key_encrypted", "is", null]);
  });

  it("createFubImportJob surfaces insert errors, missing rows, and wipe errors", async () => {
    const { db } = makeDb({ fub_import_jobs: [{ data: null, error: { message: "down" } }] });
    await expect(createFubImportJob(db, BIZ, "c", null)).rejects.toThrow("down");
    const { db: db2 } = makeDb({ fub_import_jobs: [{ data: null, error: null }] });
    await expect(createFubImportJob(db2, BIZ, "c", null)).rejects.toThrow(
      "insert returned no row"
    );
    const { db: db3 } = makeDb({
      fub_import_jobs: [
        { data: jobRow(), error: null },
        { data: null, error: { message: "wipe down" } }
      ]
    });
    await expect(createFubImportJob(db3, BIZ, "c", null)).rejects.toThrow("wipe down");
  });

  it("latestFubImportJob returns the row, null, or throws", async () => {
    const row = jobRow();
    const { db } = makeDb({ fub_import_jobs: [{ data: row, error: null }] });
    expect(await latestFubImportJob(db, BIZ)).toEqual(row);
    const { db: db2 } = makeDb({ fub_import_jobs: [{ data: null, error: null }] });
    expect(await latestFubImportJob(db2, BIZ)).toBeNull();
    const { db: db3 } = makeDb({ fub_import_jobs: [{ data: null, error: { message: "nope" } }] });
    await expect(latestFubImportJob(db3, BIZ)).rejects.toThrow("nope");
  });

  it("getFubImportJob returns the row, null, or throws", async () => {
    const row = jobRow();
    const { db } = makeDb({ fub_import_jobs: [{ data: row, error: null }] });
    expect(await getFubImportJob(db, BIZ, JOB)).toEqual(row);
    const { db: db2 } = makeDb({ fub_import_jobs: [{ data: null, error: null }] });
    expect(await getFubImportJob(db2, BIZ, JOB)).toBeNull();
    const { db: db3 } = makeDb({ fub_import_jobs: [{ data: null, error: { message: "nope" } }] });
    await expect(getFubImportJob(db3, BIZ, JOB)).rejects.toThrow("nope");
  });

  it("updateFubImportJob checks the matched count (zero rows = loud failure)", async () => {
    const { db, log } = makeDb({ fub_import_jobs: [{ data: [{ id: JOB }], error: null }] });
    await updateFubImportJob(db, BIZ, JOB, { status: "done" });
    expect(log[0].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      status: "done"
    });
    const { db: db2 } = makeDb({ fub_import_jobs: [{ data: [], error: null }] });
    await expect(updateFubImportJob(db2, BIZ, JOB, {})).rejects.toThrow("not found");
    const { db: db3 } = makeDb({ fub_import_jobs: [{ data: null, error: { message: "err" } }] });
    await expect(updateFubImportJob(db3, BIZ, JOB, {})).rejects.toThrow("err");
  });

  it("updateFubImportJob treats a null-data result as zero rows", async () => {
    const { db } = makeDb({ fub_import_jobs: [{ data: null, error: null }] });
    await expect(updateFubImportJob(db, BIZ, JOB, {})).rejects.toThrow("not found");
  });

  it("wipeFubImportJobKey reports 0 on a null-data result", async () => {
    const { db } = makeDb({ fub_import_jobs: [{ data: null, error: null }] });
    expect(await wipeFubImportJobKey(db, BIZ, JOB)).toBe(0);
  });

  it("wipeFubImportJobKey nulls the key and reports the matched count", async () => {
    const { db, log } = makeDb({ fub_import_jobs: [{ data: [{ id: JOB }], error: null }] });
    expect(await wipeFubImportJobKey(db, BIZ, JOB)).toBe(1);
    expect(log[0].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      api_key_encrypted: null
    });
    const { db: db2 } = makeDb({ fub_import_jobs: [{ data: null, error: { message: "boom" } }] });
    await expect(wipeFubImportJobKey(db2, BIZ, JOB)).rejects.toThrow("boom");
  });
});

describe("sanitizeFubError / toPublicFubImportJob", () => {
  it("scrubs every occurrence of the key and tolerates an empty key", () => {
    expect(sanitizeFubError("bad key k123 (k123)", "k123")).toBe("bad key [redacted] ([redacted])");
    expect(sanitizeFubError("unchanged", "")).toBe("unchanged");
  });

  it("serializes a job without ever exposing the ciphertext", () => {
    const pub = toPublicFubImportJob(
      jobRow({
        counts: { dryRun: { people: 2 } },
        cursor: { phase: "notes", offset: 40, next: "tok" }
      })
    );
    expect(pub).toEqual({
      id: JOB,
      status: "dry_run_done",
      dryRun: true,
      hasApiKey: true,
      counts: { dryRun: { people: 2 } },
      progress: { phase: "notes", offset: 40 },
      error: null,
      createdAt: "2026-08-20T00:00:00Z",
      updatedAt: "2026-08-20T00:00:00Z"
    });
    expect(JSON.stringify(pub)).not.toContain("enc:v1:x");
    expect(toPublicFubImportJob(jobRow({ api_key_encrypted: null })).hasApiKey).toBe(false);
    expect(toPublicFubImportJob(jobRow({ api_key_encrypted: "" })).hasApiKey).toBe(false);
  });

  it("normalizeFubCursor defaults junk to a fresh people cursor", () => {
    expect(normalizeFubCursor({})).toEqual({ phase: "people", next: null, offset: 0 });
    expect(normalizeFubCursor({ phase: "bogus", next: "", offset: -3 })).toEqual({
      phase: "people",
      next: null,
      offset: 0
    });
    expect(
      normalizeFubCursor({ phase: "deals", next: "tok", offset: 7, dealStages: { "1": "Won" } })
    ).toEqual({ phase: "deals", next: "tok", offset: 7, dealStages: { "1": "Won" } });
    expect(normalizeFubCursor({ dealStages: null })).toEqual({
      phase: "people",
      next: null,
      offset: 0
    });
  });

  it("normalizeFubRunCounts zeroes junk and clamps stored failures", () => {
    expect(normalizeFubRunCounts(undefined)).toEqual({
      contactsCreated: 0,
      contactsUpdated: 0,
      contactsSkipped: 0,
      notesImported: 0,
      notesSkipped: 0,
      dealsImported: 0,
      dealsSkipped: 0,
      failureCount: 0,
      failures: []
    });
    const long = Array.from({ length: 15 }, (_, i) => ({ scope: "person", reason: `r${i}` }));
    const normalized = normalizeFubRunCounts({
      contactsCreated: 3,
      contactsUpdated: -1,
      failures: long
    });
    expect(normalized.contactsCreated).toBe(3);
    expect(normalized.contactsUpdated).toBe(0);
    expect(normalized.failures).toHaveLength(10);
    expect(normalizeFubRunCounts({ failures: "junk" }).failures).toEqual([]);
  });
});

describe("dryRunFubImport", () => {
  it("collects totals, stages, inventories, and a sources sample", async () => {
    const client = stubClient({
      getPeople: vi
        .fn()
        .mockResolvedValueOnce(emptyPage([], { total: 120 }))
        .mockResolvedValueOnce(
          emptyPage([
            { id: 1, source: "Zillow" },
            { id: 2, source: " Zillow " },
            { id: 3, source: "Realtor.com" },
            { id: 4, source: "" },
            { id: 5 }
          ])
        ),
      getNotes: vi.fn(async () => emptyPage([], { total: 30 })),
      getDeals: vi.fn(async () => emptyPage([], { total: 4 })),
      getStages: vi.fn(async () =>
        emptyPage([
          { id: 1, name: "Lead", peopleCount: 100 },
          { id: 2, name: "  ", peopleCount: "x" as unknown as number }
        ])
      ),
      getSmartLists: vi
        .fn()
        .mockResolvedValueOnce(emptyPage([{ id: 1, name: "Hot" }], { next: "tok" }))
        .mockResolvedValueOnce(emptyPage([{ id: 2, name: " " }, { id: 3, name: "Warm" }])),
      getActionPlans: vi.fn(async () =>
        emptyPage([
          { id: 1, name: "Nurture", status: "Active" },
          { id: 2, name: "", status: "Active" },
          { id: 3, name: "Old", status: " " }
        ])
      )
    });
    const result = await dryRunFubImport(client);
    expect(result).toEqual({
      people: 120,
      notes: 30,
      deals: 4,
      stages: [
        { name: "Lead", peopleCount: 100 },
        { name: "stage 2", peopleCount: null }
      ],
      smartLists: ["Hot", "Warm"],
      actionPlans: [
        { name: "Nurture", status: "Active" },
        { name: "Old", status: null }
      ],
      sourcesSample: ["Realtor.com", "Zillow"]
    });
    // Second smart-list page was fetched with the keyset token.
    const smartLists = vi.mocked(client.getSmartLists);
    expect(smartLists.mock.calls[1][0]).toMatchObject({ next: "tok", offset: 1 });
  });

  it("tolerates inventory entries with no name or status fields at all", async () => {
    const client = stubClient({
      getStages: vi.fn(async () => emptyPage([{ id: 3 }])),
      getSmartLists: vi.fn(async () => emptyPage([{ id: 4 }])),
      getActionPlans: vi.fn(async () => emptyPage([{ id: 5 }]))
    });
    const result = await dryRunFubImport(client);
    expect(result.stages).toEqual([{ name: "stage 3", peopleCount: null }]);
    expect(result.smartLists).toEqual([]);
    expect(result.actionPlans).toEqual([]);
  });

  it("stops inventory paging when a page comes back empty despite a next token", async () => {
    const client = stubClient({
      getStages: vi.fn(async () => emptyPage([], { next: "tok" }))
    });
    const result = await dryRunFubImport(client);
    expect(result.stages).toEqual([]);
    expect(vi.mocked(client.getStages)).toHaveBeenCalledTimes(1);
  });
});

describe("runFubImportChunk: people phase", () => {
  const person = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    name: `P${id}`,
    phones: [{ value: `+1602555${String(1000 + id).slice(-4)}` }],
    ...extra
  });

  it("imports a page: created + updated + skipped, then advances to notes", async () => {
    const client = stubClient({
      getPeople: vi.fn(async () =>
        emptyPage([
          person(1, { stage: "Lead", source: "Zillow", emails: [{ value: "a@x.com" }] }),
          person(2),
          { id: 3 } // no identity
        ])
      )
    });
    upsertMock
      .mockResolvedValueOnce({ kind: "created", via: "insert", contactId: "c1", before: null })
      .mockResolvedValueOnce({
        kind: "updated",
        via: "update",
        contactId: "c2",
        before: { id: "c2", tags: [], lead_source: "Referral" }
      });
    const { db, log } = makeDb();
    const result = await runFubImportChunk(db, stubClient() && client, jobRow(), {
      deadlineMs: 10,
      now: () => 0
    });
    // One people page, then the empty notes page, then pipelines+deals page.
    expect(result.status).toBe("done");
    expect(result.counts.contactsCreated).toBe(1);
    expect(result.counts.contactsUpdated).toBe(1);
    expect(result.counts.contactsSkipped).toBe(1);
    expect(result.counts.failureCount).toBe(1);
    expect(result.counts.failures[0]).toEqual({
      scope: "person",
      reason: "person 3: no usable phone number or email address"
    });

    // The created contact carried tags + lead_source in its insert payload.
    expect(upsertMock.mock.calls[0][2]).toMatchObject({
      key: "+16025551001",
      email: "a@x.com",
      insert: expect.objectContaining({
        display_name: "P1",
        name_source: "manual",
        lead_source: "Zillow",
        tags: ["New Lead"]
      }),
      readColumns: ["tags", "lead_source"]
    });
    // contact_created fired with a job-scoped dedupe key.
    expect(fireMock).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        kind: "contact_created",
        dedupeKey: `ce:created:+16025551001:fub:${JOB}`
      })
    );
    // Progress persisted after every page (3 pages here).
    const persists = log.filter((t) => t.table === "fub_import_jobs");
    expect(persists.length).toBe(3);
    const lastPersist = persists[persists.length - 1].calls.find((c) => c.name === "update")
      ?.args[0] as Record<string, unknown>;
    expect(lastPersist.status).toBe("done");
    expect(lastPersist.dry_run).toBe(false);
  });

  it("merges tags additively, fills empty lead_source, and fires tag_changed", async () => {
    const client = stubClient({
      getPeople: vi.fn(async () =>
        emptyPage([person(1, { stage: "Pending", tags: ["VIP"], source: "Zillow" })])
      ),
      getNotes: vi.fn(async () => emptyPage()),
      getDeals: vi.fn(async () => emptyPage())
    });
    upsertMock.mockResolvedValueOnce({
      kind: "updated",
      via: "update",
      contactId: "c9",
      before: { id: "c9", tags: ["vip", "old"], lead_source: null }
    });
    const { db, log } = makeDb();
    const result = await runFubImportChunk(db, client, jobRow(), { deadlineMs: 10, now: () => 0 });
    expect(result.counts.contactsUpdated).toBe(1);
    const contactUpdate = log.find(
      (t) => t.table === "contacts" && t.calls.some((c) => c.name === "update")
    );
    expect(contactUpdate?.calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      tags: ["vip", "old", "Booked"],
      lead_source: "Zillow"
    });
    // Only the ADDED tag fires (VIP already there, case-insensitively).
    expect(fireMock).toHaveBeenCalledTimes(1);
    expect(fireMock).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        kind: "tag_changed",
        tag: "Booked",
        change: "added",
        dedupeKey: `ce:tag:+16025551001:booked:added:fub:${JOB}`
      })
    );
  });

  it("keeps an existing lead_source (fill-only) and skips the write when nothing changed", async () => {
    const client = stubClient({
      getPeople: vi.fn(async () => emptyPage([person(1, { tags: ["VIP"], source: "Zillow" })]))
    });
    upsertMock.mockResolvedValueOnce({
      kind: "updated",
      via: "update",
      contactId: "c9",
      before: { id: "c9", tags: ["VIP"], lead_source: "Referral" }
    });
    const { db, log } = makeDb();
    await runFubImportChunk(db, client, jobRow(), { deadlineMs: 10, now: () => 0 });
    expect(log.some((t) => t.table === "contacts" && t.calls.some((c) => c.name === "update"))).toBe(
      false
    );
    expect(fireMock).not.toHaveBeenCalled();
  });

  it("a promoted fold counts as created and fires contact_created with merged tags", async () => {
    const client = stubClient({
      getPeople: vi.fn(async () => emptyPage([person(1, { stage: "Lead" })]))
    });
    upsertMock.mockResolvedValueOnce({
      kind: "created",
      via: "fold_promoted",
      contactId: "c10",
      before: null
    });
    const { db, log } = makeDb();
    const result = await runFubImportChunk(db, client, jobRow(), { deadlineMs: 10, now: () => 0 });
    expect(result.counts.contactsCreated).toBe(1);
    // The promote patch had no tags, so the follow-up write adds them.
    const contactUpdate = log.find(
      (t) => t.table === "contacts" && t.calls.some((c) => c.name === "update")
    );
    expect(contactUpdate?.calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      tags: ["New Lead"]
    });
    expect(fireMock).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ kind: "contact_created", contact: expect.objectContaining({ tags: ["New Lead"] }) })
    );
  });

  it("skips the follow-up write when the row id is unknown, and records write failures", async () => {
    const client = stubClient({
      getPeople: vi.fn(async () =>
        emptyPage([person(1, { stage: "Lead" }), person(2, { stage: "Lead" })])
      )
    });
    upsertMock
      .mockResolvedValueOnce({ kind: "created", via: "fold_promoted", contactId: null, before: null })
      .mockResolvedValueOnce({ kind: "updated", via: "update", contactId: "c2", before: { id: "c2" } });
    const { db } = makeDb({
      contacts: [{ data: null, error: { message: "tags write down" } }]
    });
    const result = await runFubImportChunk(db, client, jobRow(), { deadlineMs: 10, now: () => 0 });
    // First person: created, no follow-up write attempted (contactId null).
    expect(result.counts.contactsCreated).toBe(1);
    // Second person: the tag write failed, so the row is reported.
    expect(result.counts.contactsSkipped).toBe(1);
    expect(result.counts.failures.some((f) => f.reason.includes("tags write down"))).toBe(true);
  });

  it("imports a nameless person cleanly (no display name, no name event field)", async () => {
    const client = stubClient({
      getPeople: vi.fn(async () => emptyPage([{ id: 4, phones: [{ value: "+16025551004" }] }]))
    });
    upsertMock.mockResolvedValueOnce({ kind: "created", via: "insert", contactId: "c4", before: null });
    const { db } = makeDb();
    await runFubImportChunk(db, client, jobRow(), { deadlineMs: 10, now: () => 0 });
    const input = upsertMock.mock.calls[0][2];
    expect(input.patch).toEqual({ updated_at: expect.any(String) });
    expect(input.insert).toEqual({ display_name: null, email: null });
    expect(fireMock).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ contact: { e164: "+16025551004" } })
    );
  });

  it("fills lead_source alone when every incoming tag is already there", async () => {
    const client = stubClient({
      getPeople: vi.fn(async () =>
        emptyPage([{ id: 5, phones: [{ value: "+16025551005" }], stage: "Lead", source: "Zillow" }])
      )
    });
    upsertMock.mockResolvedValueOnce({
      kind: "updated",
      via: "update",
      contactId: "c5",
      before: { id: "c5", tags: ["New Lead"], lead_source: null }
    });
    const { db, log } = makeDb();
    await runFubImportChunk(db, client, jobRow(), { deadlineMs: 10, now: () => 0 });
    const contactUpdate = log.find(
      (t) => t.table === "contacts" && t.calls.some((c) => c.name === "update")
    );
    const args = contactUpdate?.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(args.lead_source).toBe("Zillow");
    expect(args).not.toHaveProperty("tags");
    expect(fireMock).not.toHaveBeenCalled();
  });

  it("a promoted fold with only an email fires contact_created without name or tags", async () => {
    const client = stubClient({
      getPeople: vi.fn(async () =>
        emptyPage([{ id: 6, phones: [{ value: "+16025551006" }], emails: [{ value: "b@x.com" }] }])
      )
    });
    upsertMock.mockResolvedValueOnce({
      kind: "created",
      via: "fold_promoted",
      contactId: "c6",
      before: null
    });
    const { db, log } = makeDb();
    await runFubImportChunk(db, client, jobRow(), { deadlineMs: 10, now: () => 0 });
    // No tags, no lead source: nothing to reconcile, no contacts write.
    expect(log.some((t) => t.table === "contacts" && t.calls.some((c) => c.name === "update"))).toBe(
      false
    );
    expect(fireMock).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        kind: "contact_created",
        contact: { e164: "+16025551006", email: "b@x.com" }
      })
    );
  });

  it("uses the real clock when no now() is injected", async () => {
    const { db } = makeDb();
    const result = await runFubImportChunk(db, stubClient(), jobRow(), {
      deadlineMs: Date.now() + 60_000
    });
    expect(result.status).toBe("done");
  });

  it("records non-Error throws from the upsert as unexpected", async () => {
    const client = stubClient({
      getPeople: vi.fn(async () => emptyPage([person(1)]))
    });
    upsertMock.mockRejectedValueOnce("weird");
    const { db } = makeDb();
    const result = await runFubImportChunk(db, client, jobRow(), { deadlineMs: 10, now: () => 0 });
    expect(result.counts.failures[0].reason).toBe("person 1: unexpected error");
  });

  it("stops at the deadline mid-phase, keeping the keyset cursor for the next call", async () => {
    const client = stubClient({
      getPeople: vi.fn(async () => emptyPage([person(1)], { next: "tok2" }))
    });
    upsertMock.mockResolvedValueOnce({ kind: "created", via: "insert", contactId: "c1", before: null });
    let t = 0;
    const { db } = makeDb();
    const result = await runFubImportChunk(db, client, jobRow(), {
      deadlineMs: 5,
      now: () => (t += 4) // 4 on the first check, 8 on the second
    });
    expect(result.status).toBe("running");
    expect(result.cursor).toMatchObject({ phase: "people", next: "tok2", offset: 1 });
  });

  it("resumes from a stored cursor, passing the next token to FUB", async () => {
    const getPeople = vi.fn(async (_params: Record<string, unknown>) => emptyPage([]));
    const client = stubClient({ getPeople });
    const { db } = makeDb();
    const result = await runFubImportChunk(
      db,
      client,
      jobRow({ cursor: { phase: "people", next: "tok9", offset: 100 } }),
      { deadlineMs: 10, now: () => 0 }
    );
    expect(getPeople.mock.calls[0][0]).toMatchObject({ next: "tok9", offset: 100 });
    expect(result.status).toBe("done");
  });

  it("persists once even when the deadline has already passed", async () => {
    const { db, log } = makeDb();
    const result = await runFubImportChunk(db, stubClient(), jobRow(), {
      deadlineMs: 0,
      now: () => 5
    });
    expect(result.status).toBe("running");
    expect(log.filter((t) => t.table === "fub_import_jobs")).toHaveLength(1);
  });

  it("a job already done persists its done status and returns immediately", async () => {
    const { db, log } = makeDb();
    const result = await runFubImportChunk(db, stubClient(), jobRow({ cursor: { phase: "done" } }), {
      deadlineMs: 10,
      now: () => 0
    });
    expect(result.status).toBe("done");
    const persist = log[0].calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(persist.status).toBe("done");
  });
});

describe("runFubImportChunk: notes phase", () => {
  const noteJob = () => jobRow({ cursor: { phase: "notes" } });

  it("resolves people, upserts linked notes on the external key, and reports the rest", async () => {
    const client = stubClient({
      getNotes: vi.fn(async () =>
        emptyPage([
          { id: 11, personId: 1, body: "Call went well", createdBy: "Amy" },
          { id: 12, personId: 2, body: "Orphan" },
          { id: 13, personId: 1, body: "  ", subject: "" },
          { id: 14, body: "No person at all" }
        ])
      ),
      getPeopleByIds: vi.fn(async () =>
        emptyPage([
          { id: 1, phones: [{ value: "+16025551001" }] },
          { id: 2, phones: [{ value: "junk" }] }
        ])
      ),
      getDeals: vi.fn(async () => emptyPage())
    });
    const { db, log } = makeDb({
      contacts: [{ data: { id: "c1" }, error: null }] // person 1 resolves
    });
    const result = await runFubImportChunk(db, client, noteJob(), { deadlineMs: 10, now: () => 0 });
    expect(result.counts.notesImported).toBe(1);
    expect(result.counts.notesSkipped).toBe(3);
    expect(result.counts.failures.map((f) => f.scope)).toEqual(["note", "note", "note"]);
    const upsert = log.find((t) => t.table === "contact_notes");
    const [rows, opts] = upsert?.calls.find((c) => c.name === "upsert")?.args as [
      Record<string, unknown>[],
      { onConflict: string }
    ];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      business_id: BIZ,
      contact_id: "c1",
      author_user_id: null,
      author_label: "Amy",
      body: "Call went well",
      external_source: "fub",
      external_id: "11"
    });
    expect(opts).toEqual({ onConflict: "business_id,external_source,external_id" });
  });

  it("caches person resolution within the chunk (one hydration per id)", async () => {
    const getPeopleByIds = vi.fn(async (_ids: number[]) =>
      emptyPage([{ id: 1, phones: [{ value: "+16025551001" }] }])
    );
    const client = stubClient({
      getNotes: vi.fn(async () =>
        emptyPage([
          { id: 11, personId: 1, body: "a" },
          { id: 12, personId: 1, body: "b" }
        ])
      ),
      getPeopleByIds,
      getDeals: vi.fn(async () => emptyPage())
    });
    const { db } = makeDb({ contacts: [{ data: { id: "c1" }, error: null }] });
    const result = await runFubImportChunk(db, client, noteJob(), { deadlineMs: 10, now: () => 0 });
    expect(result.counts.notesImported).toBe(2);
    expect(getPeopleByIds).toHaveBeenCalledTimes(1);
    expect(getPeopleByIds.mock.calls[0][0]).toEqual([1]);
  });

  it("skips a note whose person maps but has no contact row on our side", async () => {
    const client = stubClient({
      getNotes: vi.fn(async () => emptyPage([{ id: 15, personId: 3, body: "hi" }])),
      getPeopleByIds: vi.fn(async () => emptyPage([{ id: 3, phones: [{ value: "+16025551003" }] }])),
      getDeals: vi.fn(async () => emptyPage())
    });
    // contacts default queue: lookup returns { data: null } (no match).
    const { db } = makeDb();
    const result = await runFubImportChunk(db, client, noteJob(), { deadlineMs: 10, now: () => 0 });
    expect(result.counts.notesSkipped).toBe(1);
    expect(result.counts.failures[0].reason).toBe("note 15: no matching contact for person 3");
  });

  it("skips a note whose person FUB no longer returns", async () => {
    const client = stubClient({
      getNotes: vi.fn(async () => emptyPage([{ id: 16, personId: 7, body: "hi" }])),
      getPeopleByIds: vi.fn(async () => emptyPage([])),
      getDeals: vi.fn(async () => emptyPage())
    });
    const { db } = makeDb();
    const result = await runFubImportChunk(db, client, noteJob(), { deadlineMs: 10, now: () => 0 });
    expect(result.counts.notesSkipped).toBe(1);
  });

  it("surfaces a notes upsert failure as a run failure", async () => {
    const client = stubClient({
      getNotes: vi.fn(async () => emptyPage([{ id: 11, personId: 1, body: "x" }])),
      getPeopleByIds: vi.fn(async () => emptyPage([{ id: 1, phones: [{ value: "+16025551001" }] }]))
    });
    const { db } = makeDb({
      contacts: [{ data: { id: "c1" }, error: null }],
      contact_notes: [{ data: null, error: { message: "conflict target missing" } }]
    });
    await expect(
      runFubImportChunk(db, client, noteJob(), { deadlineMs: 10, now: () => 0 })
    ).rejects.toThrow("notes upsert: conflict target missing");
  });

  it("propagates contact lookup errors", async () => {
    const client = stubClient({
      getNotes: vi.fn(async () => emptyPage([{ id: 11, personId: 1, body: "x" }])),
      getPeopleByIds: vi.fn(async () => emptyPage([{ id: 1, phones: [{ value: "+16025551001" }] }]))
    });
    const { db } = makeDb({ contacts: [{ data: null, error: { message: "db down" } }] });
    await expect(
      runFubImportChunk(db, client, noteJob(), { deadlineMs: 10, now: () => 0 })
    ).rejects.toThrow("findContactIdByKey: db down");
  });

  it("resolves email-keyed people with a plain eq lookup", async () => {
    const client = stubClient({
      getNotes: vi.fn(async () => emptyPage([{ id: 11, personId: 1, body: "x" }])),
      getPeopleByIds: vi.fn(async () => emptyPage([{ id: 1, emails: [{ value: "a@x.com" }] }])),
      getDeals: vi.fn(async () => emptyPage())
    });
    const { db, log } = makeDb({ contacts: [{ data: { id: "c1" }, error: null }] });
    const result = await runFubImportChunk(db, client, noteJob(), { deadlineMs: 10, now: () => 0 });
    expect(result.counts.notesImported).toBe(1);
    const lookup = log.find((t) => t.table === "contacts");
    expect(lookup?.calls.filter((c) => c.name === "eq").map((c) => c.args)).toContainEqual([
      "customer_e164",
      "email:a@x.com"
    ]);
    expect(lookup?.calls.some((c) => c.name === "or")).toBe(false);
  });
});

describe("runFubImportChunk: deals phase", () => {
  const dealJob = (cursor: Record<string, unknown> = { phase: "deals" }) => jobRow({ cursor });

  it("builds the stage map from pipelines once, then imports linked and unlinked deals", async () => {
    const getPipelines = vi.fn(async () =>
      emptyPage([
        {
          id: 1,
          stages: [
            { id: 3, name: "Closed Won" },
            { id: null, name: "ghost" },
            { id: 4, name: "" }
          ]
        },
        { id: 2 } // no stages array at all
      ])
    );
    const client = stubClient({
      getPipelines,
      getDeals: vi.fn(async () =>
        emptyPage([
          {
            id: 88,
            name: "123 Main St",
            price: 100,
            stageId: 3,
            people: [{ id: 1 }],
            createdAt: "2026-05-01T00:00:00Z"
          },
          { id: 89, name: "No person", stageId: 999 },
          { id: 90, status: "Archived" },
          { id: 96, name: "Unmatched person", people: [{ id: 2 }] }
        ])
      ),
      getPeopleByIds: vi.fn(async () =>
        emptyPage([
          { id: 1, phones: [{ value: "+16025551001" }] },
          { id: 2, phones: [{ value: "junk" }] }
        ])
      )
    });
    const { db, log } = makeDb({ contacts: [{ data: { id: "c1" }, error: null }] });
    const result = await runFubImportChunk(db, client, dealJob(), { deadlineMs: 10, now: () => 0 });
    expect(result.status).toBe("done");
    expect(result.counts.dealsImported).toBe(3);
    expect(result.counts.dealsSkipped).toBe(1);
    expect(result.cursor.dealStages).toEqual({ "3": "Closed Won" });
    const upsert = log.find((t) => t.table === "deals");
    const [rows, opts] = upsert?.calls.find((c) => c.name === "upsert")?.args as [
      Record<string, unknown>[],
      { onConflict: string }
    ];
    expect(rows[0]).toMatchObject({
      business_id: BIZ,
      contact_id: "c1",
      created_by: null,
      title: "123 Main St",
      value_cents: 10000,
      status: "won",
      won_at: "2026-05-01T00:00:00Z",
      external_source: "fub",
      external_id: "88"
    });
    expect(rows[0]).not.toHaveProperty("personId");
    expect(rows[1]).toMatchObject({ contact_id: null, external_id: "89", status: "open" });
    // Person 2 exists in FUB but has no usable identity: deal imports unlinked.
    expect(rows[2]).toMatchObject({ contact_id: null, external_id: "96" });
    expect(opts).toEqual({ onConflict: "business_id,external_source,external_id" });
  });

  it("reuses a cached stage map from the cursor without refetching pipelines", async () => {
    const getPipelines = vi.fn();
    const client = stubClient({
      getPipelines,
      getDeals: vi.fn(async () => emptyPage([{ id: 91, name: "Cached", stageId: 5 }]))
    });
    const { db } = makeDb();
    const result = await runFubImportChunk(
      db,
      client,
      dealJob({ phase: "deals", dealStages: { "5": "Closed Lost" } }),
      { deadlineMs: 10, now: () => 0 }
    );
    expect(getPipelines).not.toHaveBeenCalled();
    expect(result.counts.dealsImported).toBe(1);
  });

  it("surfaces a deals upsert failure", async () => {
    const client = stubClient({
      getDeals: vi.fn(async () => emptyPage([{ id: 92, name: "x" }]))
    });
    const { db } = makeDb({ deals: [{ data: null, error: { message: "no index" } }] });
    await expect(
      runFubImportChunk(db, client, dealJob(), { deadlineMs: 10, now: () => 0 })
    ).rejects.toThrow("deals upsert: no index");
  });

  it("keeps paging deals while FUB returns a next token", async () => {
    const getDeals = vi
      .fn()
      .mockResolvedValueOnce(emptyPage([{ id: 93, name: "A" }], { next: "d2" }))
      .mockResolvedValueOnce(emptyPage([{ id: 94, name: "B" }]));
    const client = stubClient({ getDeals });
    const { db } = makeDb();
    const result = await runFubImportChunk(db, client, dealJob(), { deadlineMs: 10, now: () => 0 });
    expect(result.status).toBe("done");
    expect(result.counts.dealsImported).toBe(2);
    expect(getDeals.mock.calls[1][0]).toMatchObject({ next: "d2" });
  });
});

describe("failure report cap", () => {
  it("stops recording reasons at ten but keeps counting", async () => {
    const client = stubClient({
      getPeople: vi.fn(async () => emptyPage(Array.from({ length: 12 }, (_, i) => ({ id: i }))))
    });
    const { db } = makeDb();
    const result = await runFubImportChunk(db, client, jobRow(), { deadlineMs: 10, now: () => 0 });
    expect(result.counts.failureCount).toBe(12);
    expect(result.counts.failures).toHaveLength(10);
  });
});
