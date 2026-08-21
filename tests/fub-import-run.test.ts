import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai-flows/contact-event-hooks", () => ({ fireContactEvent: vi.fn() }));
vi.mock("@/lib/contacts/identity", () => ({ upsertContactIdentity: vi.fn() }));

import {
  createFubImportJob,
  importFubCsv,
  latestFubImportJob,
  previewFubCsv,
  toPublicFubImportJob,
  updateFubImportJob,
  type FubCsvParse,
  type FubImportJobRow
} from "@/lib/fub-import/run";
import { upsertContactIdentity } from "@/lib/contacts/identity";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";
import { MAX_IMPORT_ROWS } from "@/lib/csv/contacts";

const BIZ = "00000000-0000-0000-0000-000000000001";
const JOB = "00000000-0000-0000-0000-00000000000a";

type CallLog = { name: string; args: unknown[] };
type Scripted = { data?: unknown; error?: unknown };

/**
 * Scripted PostgREST double, one result queue per table (results pop in call
 * order at each terminal await). fub_import_jobs falls back to a matched row
 * so per-row persists succeed without scripting each one.
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
    for (const m of ["select", "insert", "update", "delete", "eq", "neq", "order", "limit"]) {
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

function jobRow(overrides: Partial<FubImportJobRow> = {}): FubImportJobRow {
  return {
    id: JOB,
    business_id: BIZ,
    status: "dry_run_done",
    dry_run: true,
    counts: {},
    error: null,
    created_by: null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
    ...overrides
  };
}

const HEADER = "First Name,Last Name,Phone,Email,Stage,Source,Tags,Background";
function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

/** previewFubCsv, asserted ok so the test body can use the parse. */
function parseOk(text: string): Extract<FubCsvParse, { ok: true }> {
  const parse = previewFubCsv(text);
  if (!parse.ok) throw new Error(`expected a parse, got: ${parse.error}`);
  return parse;
}

beforeEach(() => {
  vi.mocked(upsertContactIdentity).mockReset();
  vi.mocked(fireContactEvent).mockReset();
  vi.mocked(fireContactEvent).mockResolvedValue(undefined as never);
});

describe("previewFubCsv", () => {
  it("counts importable and unusable rows and names the ignored columns", () => {
    const parse = parseOk(
      csv(
        "Jane,Doe,(602) 555-1234,jane@example.com,Lead,Zillow,buyer,some background",
        "Sam,Okoye,,sam@example.com,Contacted,Referral,,",
        "Ghost,Person,,,Lead,,,"
      )
    );
    expect(parse.preview.totalRows).toBe(3);
    expect(parse.preview.importable).toBe(2);
    expect(parse.preview.unusable).toBe(1);
    expect(parse.preview.ignoredColumns).toEqual(["background"]);
    expect(parse.preview.problems).toHaveLength(1);
    expect(parse.preview.problems[0]).toContain("row 4");
  });

  it("reports which file column feeds each of our fields", () => {
    const parse = parseOk(csv("Jane,Doe,+16025551234,jane@example.com,Lead,Zillow,buyer,x"));
    expect(parse.preview.mapping).toEqual({
      firstName: ["first_name"],
      lastName: ["last_name"],
      phone: ["phone"],
      email: ["email"],
      stage: ["stage"],
      source: ["source"],
      tags: ["tags"]
    });
  });

  it("omits fields the file has no column for, rather than listing them empty", () => {
    const parse = parseOk("Phone\n+16025551234");
    expect(Object.keys(parse.preview.mapping)).toEqual(["phone"]);
  });

  it("refuses a file with no phone or email column and says how to re-export", () => {
    const parse = previewFubCsv("First Name,Stage\nJane,Lead");
    expect(parse.ok).toBe(false);
    if (parse.ok) return;
    expect(parse.error).toContain("No phone or email column");
    expect(parse.error).toContain("Export All Columns");
  });

  it("passes a structurally broken file's own error through", () => {
    const parse = previewFubCsv('Phone\n"unterminated');
    expect(parse.ok).toBe(false);
    if (parse.ok) return;
    expect(parse.error).toContain("Unterminated quoted field");
  });

  it("refuses an empty file", () => {
    const parse = previewFubCsv("   ");
    expect(parse.ok).toBe(false);
    if (parse.ok) return;
    expect(parse.error).toContain("empty");
  });

  it("refuses a file over the row cap and tells the owner to export in batches", () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `+1602555${1000 + i}`);
    const parse = previewFubCsv(["Phone", ...rows].join("\n"));
    expect(parse.ok).toBe(false);
    if (parse.ok) return;
    expect(parse.error).toContain(String(MAX_IMPORT_ROWS));
    expect(parse.error).toContain("batches");
  });

  it("caps the reported problems rather than echoing the whole file back", () => {
    const rows = Array.from({ length: 25 }, (_, i) => `Ghost${i},Person,,,Lead,,,`);
    const parse = parseOk(csv(...rows));
    expect(parse.preview.unusable).toBe(25);
    expect(parse.preview.problems).toHaveLength(10);
  });
});

describe("importFubCsv", () => {
  it("creates a contact and fires contact_created with the mapped tags", async () => {
    vi.mocked(upsertContactIdentity).mockResolvedValue({
      kind: "created",
      via: "insert",
      contactId: "c1",
      before: null
    } as never);
    const { db } = makeDb();
    const parse = parseOk(csv("Jane,Doe,+16025551234,jane@example.com,Lead,Zillow,buyer,x"));
    const summary = await importFubCsv(db, BIZ, JOB, parse);

    expect(summary).toMatchObject({ totalRows: 1, created: 1, updated: 0, skipped: 0 });
    const insert = vi.mocked(upsertContactIdentity).mock.calls[0][2] as {
      insert: Record<string, unknown>;
    };
    expect(insert.insert.lead_source).toBe("Zillow");
    expect(insert.insert.tags).toEqual(expect.arrayContaining(["New Lead", "buyer"]));
    expect(vi.mocked(fireContactEvent).mock.calls[0][1]).toMatchObject({
      kind: "contact_created",
      dedupeKey: `ce:created:+16025551234:fub:${JOB}`
    });
  });

  it("merges tags additively and fills lead_source only when it is empty", async () => {
    vi.mocked(upsertContactIdentity).mockResolvedValue({
      kind: "updated",
      contactId: "c1",
      before: { tags: ["vip"], lead_source: null }
    } as never);
    const { db, log } = makeDb();
    const parse = parseOk(csv("Jane,Doe,+16025551234,jane@example.com,Lead,Zillow,buyer,x"));
    const summary = await importFubCsv(db, BIZ, JOB, parse);

    expect(summary).toMatchObject({ created: 0, updated: 1, skipped: 0 });
    const update = log.find((l) => l.table === "contacts");
    const patch = update?.calls.find((c) => c.name === "update")?.args[0] as Record<string, unknown>;
    expect(patch.tags).toEqual(expect.arrayContaining(["vip", "New Lead", "buyer"]));
    expect(patch.lead_source).toBe("Zillow");
    // tag_changed per newly added tag, never for the one already there.
    const tagEvents = vi
      .mocked(fireContactEvent)
      .mock.calls.map((c) => c[1] as { kind: string; tag?: string });
    expect(tagEvents.every((e) => e.kind === "tag_changed")).toBe(true);
    expect(tagEvents.map((e) => e.tag).sort()).toEqual(["New Lead", "buyer"]);
  });

  it("writes the new tag alone when the contact already has a lead source", async () => {
    vi.mocked(upsertContactIdentity).mockResolvedValue({
      kind: "updated",
      contactId: "c1",
      before: { tags: ["vip"], lead_source: "Referral" }
    } as never);
    const { db, log } = makeDb();
    const parse = parseOk(csv("Jane,Doe,+16025551234,jane@example.com,Lead,Zillow,buyer,x"));
    await importFubCsv(db, BIZ, JOB, parse);
    const patch = log
      .find((l) => l.table === "contacts")
      ?.calls.find((c) => c.name === "update")?.args[0] as Record<string, unknown>;
    expect(patch.tags).toEqual(expect.arrayContaining(["vip", "New Lead", "buyer"]));
    expect(patch).not.toHaveProperty("lead_source");
  });

  it("fills the lead source alone when every tag is already on the contact", async () => {
    vi.mocked(upsertContactIdentity).mockResolvedValue({
      kind: "updated",
      contactId: "c1",
      before: { tags: ["New Lead", "buyer"], lead_source: null }
    } as never);
    const { db, log } = makeDb();
    const parse = parseOk(csv("Jane,Doe,+16025551234,jane@example.com,Lead,Zillow,buyer,x"));
    await importFubCsv(db, BIZ, JOB, parse);
    const patch = log
      .find((l) => l.table === "contacts")
      ?.calls.find((c) => c.name === "update")?.args[0] as Record<string, unknown>;
    expect(patch.lead_source).toBe("Zillow");
    expect(patch).not.toHaveProperty("tags");
    expect(vi.mocked(fireContactEvent)).not.toHaveBeenCalled();
  });

  it("leaves an existing lead_source alone", async () => {
    vi.mocked(upsertContactIdentity).mockResolvedValue({
      kind: "updated",
      contactId: "c1",
      before: { tags: ["New Lead", "buyer"], lead_source: "Referral" }
    } as never);
    const { db, log } = makeDb();
    const parse = parseOk(csv("Jane,Doe,+16025551234,jane@example.com,Lead,Zillow,buyer,x"));
    await importFubCsv(db, BIZ, JOB, parse);
    // Nothing new to write: no tags added and lead_source already set.
    expect(log.some((l) => l.table === "contacts")).toBe(false);
    expect(vi.mocked(fireContactEvent)).not.toHaveBeenCalled();
  });

  it("fires contact_created for a fold promoted without its tags", async () => {
    vi.mocked(upsertContactIdentity).mockResolvedValue({
      kind: "created",
      via: "promote",
      contactId: "c1",
      before: null
    } as never);
    const { db } = makeDb();
    const parse = parseOk(csv("Jane,Doe,+16025551234,jane@example.com,Lead,Zillow,buyer,x"));
    const summary = await importFubCsv(db, BIZ, JOB, parse);
    expect(summary.created).toBe(1);
    expect(vi.mocked(fireContactEvent).mock.calls[0][1]).toMatchObject({
      kind: "contact_created"
    });
  });

  it("records a row that has no identity and keeps importing the rest", async () => {
    vi.mocked(upsertContactIdentity).mockResolvedValue({
      kind: "created",
      via: "insert",
      contactId: "c1",
      before: null
    } as never);
    const { db } = makeDb();
    const parse = parseOk(
      csv("Ghost,Person,,,Lead,,,", "Jane,Doe,+16025551234,jane@example.com,Lead,Zillow,buyer,x")
    );
    const summary = await importFubCsv(db, BIZ, JOB, parse);
    expect(summary).toMatchObject({ totalRows: 2, created: 1, skipped: 1 });
    expect(summary.failures[0]).toContain("row 2");
  });

  it("records a row that throws and keeps importing the rest", async () => {
    vi.mocked(upsertContactIdentity)
      .mockRejectedValueOnce(new Error("contacts write failed"))
      .mockResolvedValue({
        kind: "created",
        via: "insert",
        contactId: "c1",
        before: null
      } as never);
    const { db } = makeDb();
    const parse = parseOk(
      csv(
        "Jane,Doe,+16025551234,jane@example.com,Lead,Zillow,buyer,x",
        "Sam,Okoye,+16025559999,sam@example.com,Lead,Zillow,,x"
      )
    );
    const summary = await importFubCsv(db, BIZ, JOB, parse);
    expect(summary).toMatchObject({ created: 1, skipped: 1 });
    expect(summary.failures[0]).toContain("row 2: contacts write failed");
  });

  it("reports a non-Error throw without crashing the run", async () => {
    vi.mocked(upsertContactIdentity).mockRejectedValue("nope" as never);
    const { db } = makeDb();
    const parse = parseOk(csv("Jane,Doe,+16025551234,jane@example.com,Lead,Zillow,buyer,x"));
    const summary = await importFubCsv(db, BIZ, JOB, parse);
    expect(summary.failures[0]).toContain("unexpected error");
  });

  it("surfaces a failed tag/source update rather than counting the row as imported", async () => {
    vi.mocked(upsertContactIdentity).mockResolvedValue({
      kind: "updated",
      contactId: "c1",
      before: { tags: [], lead_source: null }
    } as never);
    const { db } = makeDb({ contacts: [{ data: null, error: { message: "denied" } }] });
    const parse = parseOk(csv("Jane,Doe,+16025551234,jane@example.com,Lead,Zillow,buyer,x"));
    const summary = await importFubCsv(db, BIZ, JOB, parse);
    expect(summary).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect(summary.failures[0]).toContain("tag/source update: denied");
  });

  it("treats a non-array before.tags as no tags rather than throwing", async () => {
    vi.mocked(upsertContactIdentity).mockResolvedValue({
      kind: "updated",
      contactId: "c1",
      before: { tags: null, lead_source: null }
    } as never);
    const { db, log } = makeDb();
    const parse = parseOk(csv("Jane,Doe,+16025551234,jane@example.com,Lead,Zillow,buyer,x"));
    const summary = await importFubCsv(db, BIZ, JOB, parse);
    expect(summary.updated).toBe(1);
    const patch = log
      .find((l) => l.table === "contacts")
      ?.calls.find((c) => c.name === "update")?.args[0] as Record<string, unknown>;
    expect(patch.tags).toEqual(expect.arrayContaining(["New Lead", "buyer"]));
  });

  it("skips the follow-up write when the core returns no contact id", async () => {
    vi.mocked(upsertContactIdentity).mockResolvedValue({
      kind: "updated",
      contactId: null,
      before: { tags: [], lead_source: null }
    } as never);
    const { db, log } = makeDb();
    const parse = parseOk(csv("Jane,Doe,+16025551234,jane@example.com,Lead,Zillow,buyer,x"));
    const summary = await importFubCsv(db, BIZ, JOB, parse);
    expect(summary.updated).toBe(1);
    expect(log.some((l) => l.table === "contacts")).toBe(false);
  });

  it("imports a phone-only row without inventing a name, email, source or tags", async () => {
    vi.mocked(upsertContactIdentity).mockResolvedValue({
      kind: "created",
      via: "insert",
      contactId: "c1",
      before: null
    } as never);
    const { db } = makeDb();
    const summary = await importFubCsv(db, BIZ, JOB, parseOk("Phone\n+16025551234"));

    expect(summary).toMatchObject({ created: 1, skipped: 0 });
    const arg = vi.mocked(upsertContactIdentity).mock.calls[0][2] as {
      patch: Record<string, unknown>;
      insert: Record<string, unknown>;
    };
    // A blank cell means "we know nothing", never "clear what is there".
    expect(arg.patch).toEqual({ updated_at: expect.any(String) });
    expect(arg.insert).toEqual({ display_name: null, email: null });
    expect(vi.mocked(fireContactEvent).mock.calls[0][1]).toEqual({
      kind: "contact_created",
      contact: { e164: "+16025551234" },
      dedupeKey: `ce:created:+16025551234:fub:${JOB}`
    });
  });

  it("announces a phone-only fold promotion with nothing but the number", async () => {
    vi.mocked(upsertContactIdentity).mockResolvedValue({
      kind: "created",
      via: "promote",
      contactId: "c1",
      before: null
    } as never);
    const { db } = makeDb();
    await importFubCsv(db, BIZ, JOB, parseOk("Phone\n+16025551234"));
    expect(vi.mocked(fireContactEvent).mock.calls[0][1]).toEqual({
      kind: "contact_created",
      contact: { e164: "+16025551234" },
      dedupeKey: `ce:created:+16025551234:fub:${JOB}`
    });
  });

  it("writes nothing extra when a phone-only row updates an existing contact", async () => {
    vi.mocked(upsertContactIdentity).mockResolvedValue({
      kind: "updated",
      contactId: "c1",
      before: { tags: ["vip"], lead_source: "Referral" }
    } as never);
    const { db, log } = makeDb();
    const summary = await importFubCsv(db, BIZ, JOB, parseOk("Phone\n+16025551234"));
    expect(summary.updated).toBe(1);
    expect(log.some((l) => l.table === "contacts")).toBe(false);
    expect(vi.mocked(fireContactEvent)).not.toHaveBeenCalled();
  });

  it("caps recorded failures at ten however many rows fail", async () => {
    const { db } = makeDb();
    const parse = parseOk(csv(...Array.from({ length: 25 }, (_, i) => `G${i},P,,,Lead,,,`)));
    const summary = await importFubCsv(db, BIZ, JOB, parse);
    expect(summary.skipped).toBe(25);
    expect(summary.failures).toHaveLength(10);
  });
});

describe("job rows", () => {
  it("inserts a job carrying its business, actor and dry-run flag", async () => {
    const { db, log } = makeDb({
      fub_import_jobs: [{ data: jobRow(), error: null }]
    });
    const row = await createFubImportJob(db, BIZ, "user-1", true);
    expect(row.id).toBe(JOB);
    const insert = log[0].calls.find((c) => c.name === "insert")?.args[0] as Record<string, unknown>;
    expect(insert).toEqual({ business_id: BIZ, created_by: "user-1", dry_run: true });
  });

  it("throws when the insert returns no row", async () => {
    const { db } = makeDb({ fub_import_jobs: [{ data: null, error: null }] });
    await expect(createFubImportJob(db, BIZ, null, false)).rejects.toThrow(
      "insert returned no row"
    );
  });

  it("throws with the database's message when the insert errors", async () => {
    const { db } = makeDb({
      fub_import_jobs: [{ data: null, error: { message: "denied" } }]
    });
    await expect(createFubImportJob(db, BIZ, null, false)).rejects.toThrow("denied");
  });

  it("reads the newest job for the status card", async () => {
    const { db, log } = makeDb({ fub_import_jobs: [{ data: jobRow(), error: null }] });
    const row = await latestFubImportJob(db, BIZ);
    expect(row?.id).toBe(JOB);
    expect(log[0].calls.find((c) => c.name === "order")?.args[0]).toBe("created_at");
  });

  it("returns null when the business has never imported", async () => {
    const { db } = makeDb({ fub_import_jobs: [{ data: null, error: null }] });
    expect(await latestFubImportJob(db, BIZ)).toBeNull();
  });

  it("throws when the newest-job read errors", async () => {
    const { db } = makeDb({
      fub_import_jobs: [{ data: null, error: { message: "boom" } }]
    });
    await expect(latestFubImportJob(db, BIZ)).rejects.toThrow("boom");
  });

  it("treats a patch that matched nothing as an error, not a silent no-op", async () => {
    const { db } = makeDb({ fub_import_jobs: [{ data: [], error: null }] });
    await expect(updateFubImportJob(db, BIZ, JOB, { status: "done" })).rejects.toThrow(
      "not found"
    );
  });

  it("treats a null patch result as not found rather than reading through it", async () => {
    const { db } = makeDb({ fub_import_jobs: [{ data: null, error: null }] });
    await expect(updateFubImportJob(db, BIZ, JOB, { status: "done" })).rejects.toThrow(
      "not found"
    );
  });

  it("throws with the database's message when the patch errors", async () => {
    const { db } = makeDb({
      fub_import_jobs: [{ data: null, error: { message: "denied" } }]
    });
    await expect(updateFubImportJob(db, BIZ, JOB, { status: "done" })).rejects.toThrow("denied");
  });

  it("scopes the patch to the business as well as the job", async () => {
    const { db, log } = makeDb();
    await updateFubImportJob(db, BIZ, JOB, { status: "done" });
    const eqs = log[0].calls.filter((c) => c.name === "eq").map((c) => c.args);
    expect(eqs).toEqual([
      ["business_id", BIZ],
      ["id", JOB]
    ]);
  });

  it("exposes only the fields the dashboard needs", () => {
    const row = jobRow({ counts: { preview: { totalRows: 3 } }, error: null });
    expect(toPublicFubImportJob(row)).toEqual({
      id: JOB,
      status: "dry_run_done",
      dryRun: true,
      counts: { preview: { totalRows: 3 } },
      error: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  });
});
