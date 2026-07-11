import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
// Mock the default-client factory so calls WITHOUT the `client` arg exercise
// the `client ?? (await createSupabaseServiceClient())` fallback.
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));
vi.mock("@/lib/ai-flows/contact-event-hooks", () => ({ fireContactEvent: vi.fn() }));

import {
  CONTACTS_EXPORT_HEADERS,
  MAX_IMPORT_ROWS,
  contactsCsvTemplate,
  exportContactsCsv,
  importContactsCsv
} from "../src/lib/csv/contacts";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";
import { parseCsv } from "../src/lib/csv/csv";

/**
 * Coverage for src/lib/csv/contacts.ts. Same mocked-PostgREST approach as
 * tests/customer-memory-db.test.ts: a chainable builder that records calls
 * and pops scripted `{ data, error }` results at each terminal await.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";

type CallLog = { name: string; args: unknown[] };
type Scripted = { data?: unknown; error?: unknown } | (() => never);

function makeDb(results: Scripted[]) {
  const log: { table: string; calls: CallLog[] }[] = [];
  let idx = 0;
  const next = () => {
    const r = results[idx++] ?? { data: null, error: null };
    if (typeof r === "function") r();
    return r as { data?: unknown; error?: unknown };
  };
  const from = (table: string) => {
    const calls: CallLog[] = [];
    log.push({ table, calls });
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "insert", "update", "delete", "eq", "or", "order", "range", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ name: m, args });
        return builder;
      };
    }
    builder["maybeSingle"] = async () => {
      calls.push({ name: "maybeSingle", args: [] });
      return next();
    };
    // Chains awaited without a terminal method (insert/update) resolve here.
    builder["then"] = (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown
    ) => {
      let value: unknown;
      try {
        value = next();
      } catch (e) {
        return Promise.reject(e).catch(reject);
      }
      return Promise.resolve(value).then(resolve);
    };
    return builder;
  };
  return { db: { from } as never, log };
}

function contactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    customer_e164: "+15550001111",
    display_name: "Jane Doe",
    type: "customer",
    email: "jane@example.com",
    sms_reply_mode: "auto",
    pinned_md: "VIP, prefers texts",
    tags: ["VIP", "spanish"],
    alias_e164s: ["+15550009999"],
    last_channel: "sms",
    last_interaction_at: "2026-06-01T00:00:00Z",
    total_interaction_count: 7,
    created_at: "2026-05-01T00:00:00Z",
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("exportContactsCsv", () => {
  it("writes the header plus one line per contact, with null fields as empty", async () => {
    const { db, log } = makeDb([
      {
        data: [
          contactRow(),
          contactRow({
            id: "row-2",
            customer_e164: "+15550002222",
            display_name: null,
            email: null,
            pinned_md: null,
            tags: null,
            alias_e164s: null,
            last_channel: null,
            last_interaction_at: null
          })
        ],
        error: null
      }
    ]);
    const csv = await exportContactsCsv(BIZ, db);
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.headers).toEqual([...CONTACTS_EXPORT_HEADERS]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      phone: "+15550001111",
      name: "Jane Doe",
      tags: "VIP, spanish",
      aliases: "+15550009999",
      total_interactions: "7"
    });
    expect(parsed.rows[1]).toMatchObject({
      phone: "+15550002222",
      name: "",
      email: "",
      tags: "",
      aliases: "",
      last_channel: ""
    });
    // Wire shape: contacts table, business filter, created_at order, range page.
    expect(log[0].table).toBe("contacts");
    expect(log[0].calls.find((c) => c.name === "eq")?.args).toEqual(["business_id", BIZ]);
    expect(log[0].calls.find((c) => c.name === "range")?.args).toEqual([0, 999]);
  });

  it("paginates past a full first page", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) =>
      contactRow({ id: `row-${i}`, customer_e164: `+1555000${String(i).padStart(4, "0")}` })
    );
    const { db, log } = makeDb([
      { data: fullPage, error: null },
      { data: [contactRow({ id: "row-last", customer_e164: "+15559990000" })], error: null }
    ]);
    const csv = await exportContactsCsv(BIZ, db);
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows).toHaveLength(1001);
    expect(log[1].calls.find((c) => c.name === "range")?.args).toEqual([1000, 1999]);
  });

  it("treats a null data page as empty", async () => {
    const { db } = makeDb([{ data: null, error: null }]);
    const csv = await exportContactsCsv(BIZ, db);
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows).toHaveLength(0);
  });

  it("throws on a query error", async () => {
    const { db } = makeDb([{ data: null, error: { message: "boom" } }]);
    await expect(exportContactsCsv(BIZ, db)).rejects.toThrow("exportContactsCsv: boom");
  });

  it("falls back to the default service client when none is passed", async () => {
    const { db } = makeDb([{ data: [], error: null }]);
    defaultClientSpy.mockReturnValue(db);
    await exportContactsCsv(BIZ);
    expect(defaultClientSpy).toHaveBeenCalledTimes(1);
  });
});

describe("contactsCsvTemplate", () => {
  it("has the importable headers and one example row", () => {
    const parsed = parseCsv(contactsCsvTemplate());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.headers).toEqual([
      "phone",
      "name",
      "type",
      "email",
      "sms_reply_mode",
      "pinned_notes"
    ]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].phone).toBe("+16025551234");
  });
});

describe("importContactsCsv", () => {
  it("reports a structural parse failure as a row-0 error", async () => {
    const { db } = makeDb([]);
    const summary = await importContactsCsv(BIZ, 'phone\n"+1555', db);
    expect(summary.totalRows).toBe(0);
    expect(summary.errors[0].row).toBe(0);
    expect(summary.errors[0].message).toMatch(/Unterminated/);
  });

  it("requires the phone column", async () => {
    const { db } = makeDb([]);
    const summary = await importContactsCsv(BIZ, "name\nJane", db);
    expect(summary.errors).toEqual([{ row: 1, message: 'Missing required column: "phone".' }]);
  });

  it("rejects files over the row cap", async () => {
    const lines = ["phone", ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => "+16025551234")];
    const { db } = makeDb([]);
    const summary = await importContactsCsv(BIZ, lines.join("\n"), db);
    expect(summary.errors[0].message).toMatch(/Too many rows \(2001\)/);
    expect(summary.totalRows).toBe(0);
  });

  it("creates a new contact, normalizing a 10-digit US number", async () => {
    const { db, log } = makeDb([
      { data: null, error: null }, // lookup: no existing
      { data: null, error: null } // insert ok
    ]);
    const summary = await importContactsCsv(
      BIZ,
      "phone,name,type,email,sms_reply_mode,pinned_notes\n(602) 555-1234,Jane,customer,jane@example.com,suppress,VIP",
      db
    );
    expect(summary).toMatchObject({ totalRows: 1, created: 1, updated: 0, skipped: 0 });
    // A created row fires the contact_created trigger hook (best-effort).
    expect(fireContactEvent).toHaveBeenCalledWith(BIZ, {
      kind: "contact_created",
      contact: { e164: "+16025551234", name: "Jane", email: "jane@example.com" },
      dedupeKey: `ce:created:${BIZ}:+16025551234`
    });
    expect(summary.errors).toEqual([]);
    const insert = log[1].calls.find((c) => c.name === "insert");
    expect(insert?.args[0]).toMatchObject({
      business_id: BIZ,
      customer_e164: "+16025551234",
      display_name: "Jane",
      name_source: "manual",
      email: "jane@example.com",
      type: "customer",
      sms_reply_mode: "suppress",
      pinned_md: "VIP"
    });
  });

  it("creates with nulls when optional cells are blank (no manual name_source)", async () => {
    const { db, log } = makeDb([
      { data: null, error: null },
      { data: null, error: null }
    ]);
    const summary = await importContactsCsv(BIZ, "phone\n+16025551234", db);
    expect(summary.created).toBe(1);
    const insert = log[1].calls.find((c) => c.name === "insert");
    expect(insert?.args[0]).toEqual({
      business_id: BIZ,
      customer_e164: "+16025551234",
      display_name: null,
      email: null,
      pinned_md: null
    });
  });

  it("updates an existing contact (alias-aware lookup) with only the provided cells", async () => {
    const { db, log } = makeDb([
      { data: { id: "existing-1" }, error: null },
      { data: null, error: null }
    ]);
    const summary = await importContactsCsv(
      BIZ,
      "phone,name,email\n+16025551234,Jane Doe,jane@example.com",
      db
    );
    expect(summary).toMatchObject({ created: 0, updated: 1, skipped: 0 });
    // Lookup matched primary OR alias.
    expect(log[0].calls.find((c) => c.name === "or")?.args[0]).toBe(
      "customer_e164.eq.+16025551234,alias_e164s.cs.{+16025551234}"
    );
    const update = log[1].calls.find((c) => c.name === "update");
    expect(update?.args[0]).toMatchObject({
      display_name: "Jane Doe",
      name_source: "manual",
      email: "jane@example.com"
    });
    expect(update?.args[0]).not.toHaveProperty("type");
    expect(update?.args[0]).not.toHaveProperty("pinned_md");
    expect(log[1].calls.find((c) => c.name === "eq")?.args).toEqual(["id", "existing-1"]);
  });

  it("updates with only updated_at when every optional cell is blank", async () => {
    const { db, log } = makeDb([
      { data: { id: "existing-1" }, error: null },
      { data: null, error: null }
    ]);
    const summary = await importContactsCsv(
      BIZ,
      "phone,name,type,email,sms_reply_mode,pinned_notes\n+16025551234,,,,,",
      db
    );
    expect(summary.updated).toBe(1);
    const patch = log[1].calls.find((c) => c.name === "update")?.args[0] as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(["updated_at"]);
  });

  it("applies type and sms_reply_mode updates when provided", async () => {
    const { db, log } = makeDb([
      { data: { id: "existing-1" }, error: null },
      { data: null, error: null }
    ]);
    await importContactsCsv(
      BIZ,
      "phone,type,sms_reply_mode,pinned_notes\n+16025551234,tester,forward_owner,Note here",
      db
    );
    const patch = log[1].calls.find((c) => c.name === "update")?.args[0] as Record<string, unknown>;
    expect(patch).toMatchObject({
      type: "tester",
      sms_reply_mode: "forward_owner",
      pinned_md: "Note here"
    });
  });

  it("skips rows with an invalid phone, email, type, or sms_reply_mode", async () => {
    const { db } = makeDb([]);
    const summary = await importContactsCsv(
      BIZ,
      [
        "phone,name,type,email,sms_reply_mode",
        "not-a-phone,Jane,,,",
        "+16025551234,Jane,,bad-email,",
        "+16025551234,Jane,alien,,",
        "+16025551234,Jane,,,shout"
      ].join("\n"),
      db
    );
    expect(summary).toMatchObject({ totalRows: 4, created: 0, updated: 0, skipped: 4 });
    expect(summary.errors.map((e) => e.row)).toEqual([2, 3, 4, 5]);
    expect(summary.errors[0].message).toMatch(/^phone:/);
    expect(summary.errors[1].message).toMatch(/^email:/);
    expect(summary.errors[2].message).toMatch(/^type:/);
    expect(summary.errors[3].message).toMatch(/^sms_reply_mode:/);
  });

  it("applies the row as an update after an insert unique-violation race", async () => {
    const { db, log } = makeDb([
      { data: null, error: null }, // first lookup: nothing yet
      { data: null, error: { code: "23505", message: "duplicate key" } }, // insert races
      { data: { id: "raced-row" }, error: null }, // re-lookup finds the winner
      { data: null, error: null } // update applies the row's fields
    ]);
    const summary = await importContactsCsv(BIZ, "phone,name\n+16025551234,Jane", db);
    expect(summary).toMatchObject({ created: 0, updated: 1, skipped: 0 });
    expect(summary.errors).toEqual([]);
    const update = log[3].calls.find((c) => c.name === "update");
    expect(update?.args[0]).toMatchObject({ display_name: "Jane", name_source: "manual" });
  });

  it("reports the row when the racing profile vanishes before the retry", async () => {
    const { db } = makeDb([
      { data: null, error: null }, // first lookup: nothing
      { data: null, error: { code: "23505", message: "duplicate key" } }, // insert races
      { data: null, error: null } // re-lookup: gone again (concurrent delete/merge)
    ]);
    const summary = await importContactsCsv(BIZ, "phone\n+16025551234", db);
    expect(summary).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect(summary.errors[0].message).toMatch(/concurrent change kept \+16025551234/);
  });

  it("reports lookup, update, and insert errors per row and keeps going", async () => {
    const { db } = makeDb([
      { data: null, error: { message: "select down" } }, // row 1 lookup fails
      { data: { id: "x" }, error: null }, // row 2 lookup ok
      { data: null, error: { message: "update down" } }, // row 2 update fails
      { data: null, error: null }, // row 3 lookup ok (no existing)
      { data: null, error: { code: "999", message: "insert down" } } // row 3 insert fails
    ]);
    const summary = await importContactsCsv(
      BIZ,
      "phone\n+16025551111\n+16025552222\n+16025553333",
      db
    );
    expect(summary).toMatchObject({ totalRows: 3, created: 0, updated: 0, skipped: 3 });
    expect(summary.errors).toEqual([
      { row: 2, message: "select down" },
      { row: 3, message: "update down" },
      { row: 4, message: "insert down" }
    ]);
  });

  it("labels a non-Error throw as unexpected", async () => {
    const { db } = makeDb([
      () => {
        throw "string failure";
      }
    ]);
    const summary = await importContactsCsv(BIZ, "phone\n+16025551234", db);
    expect(summary.errors).toEqual([{ row: 2, message: "Unexpected error" }]);
  });

  it("falls back to the default service client when none is passed", async () => {
    const { db } = makeDb([
      { data: null, error: null },
      { data: null, error: null }
    ]);
    defaultClientSpy.mockReturnValue(db);
    const summary = await importContactsCsv(BIZ, "phone\n+16025551234");
    expect(summary.created).toBe(1);
    expect(defaultClientSpy).toHaveBeenCalledTimes(1);
  });
});
