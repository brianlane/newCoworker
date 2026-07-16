import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  DOCUMENTS_EXPORT_HEADERS,
  MAX_DOCUMENT_IMPORT_ROWS,
  documentsCsvTemplate,
  exportDocumentsCsv,
  importDocumentsCsv
} from "../src/lib/csv/documents";
import { parseCsv, serializeCsv } from "../src/lib/csv/csv";

/**
 * Coverage for src/lib/csv/documents.ts — the contact-records ("book of
 * business") importer/exporter. Mirrors tests/csv-employees.test.ts
 * (chainable recorded builder popping scripted results) plus a scripted
 * storage mock for the synthesized record originals.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";

type CallLog = { name: string; args: unknown[] };
type Scripted = { data?: unknown; error?: unknown; count?: number | null } | (() => never);

function makeDb(results: Scripted[], storageResults: Array<{ error: unknown }> = []) {
  const log: { table: string; calls: CallLog[] }[] = [];
  const storageCalls: Array<{ name: string; args: unknown[] }> = [];
  let idx = 0;
  let storageIdx = 0;
  const next = () => {
    const r = results[idx++] ?? { data: null, error: null };
    if (typeof r === "function") r();
    return r as { data?: unknown; error?: unknown; count?: number | null };
  };
  const from = (table: string) => {
    const calls: CallLog[] = [];
    log.push({ table, calls });
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "insert", "update", "delete", "eq", "or", "not", "in", "order", "range", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ name: m, args });
        return builder;
      };
    }
    builder["maybeSingle"] = async () => {
      calls.push({ name: "maybeSingle", args: [] });
      return next();
    };
    builder["then"] = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
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
  const storage = {
    from: (bucket: string) => ({
      upload: async (...args: unknown[]) => {
        storageCalls.push({ name: `upload:${bucket}`, args });
        return storageResults[storageIdx++] ?? { error: null };
      },
      remove: async (...args: unknown[]) => {
        storageCalls.push({ name: `remove:${bucket}`, args });
        return storageResults[storageIdx++] ?? { error: null };
      }
    })
  };
  return { db: { from, storage } as never, log, storageCalls };
}

const CONTACT = { id: "c-1", display_name: "Jane Doe", customer_e164: "+16025551234" };

function importCsv(rows: string[][]): string {
  return serializeCsv([
    ["title", "contact_phone", "category", "renewal_date", "expires_at", "assigned_employee_phone", "audience", "notes"],
    ...rows
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("documentsCsvTemplate", () => {
  it("parses back with the importable columns", () => {
    const parsed = parseCsv(documentsCsvTemplate());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.headers).toContain("title");
    expect(parsed.headers).toContain("contact_phone");
    expect(parsed.headers).toContain("renewal_date");
    expect(parsed.rows).toHaveLength(1);
  });
});

describe("exportDocumentsCsv", () => {
  const docRow = {
    title: "Auto policy",
    category: "policy",
    audience: "staff",
    content_md: "Premium $1,240/yr",
    status: "ready",
    contact_id: "c-1",
    renewal_date: "2027-03-01T23:59:59.999Z",
    expires_at: null,
    assigned_employee_id: "m-1",
    created_at: "2026-07-01T00:00:00Z"
  };

  it("writes linked records with contact + assignee resolved", async () => {
    const { db, log } = makeDb([
      { data: [docRow], error: null },
      { data: [CONTACT], error: null },
      { data: [{ id: "m-1", phone_e164: "+16025559876" }], error: null }
    ]);
    const parsed = parseCsv(await exportDocumentsCsv(BIZ, db));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.headers).toEqual([...DOCUMENTS_EXPORT_HEADERS]);
    expect(parsed.rows[0]).toMatchObject({
      title: "Auto policy",
      contact_phone: "+16025551234",
      contact_name: "Jane Doe",
      renewal_date: "2027-03-01",
      expires_at: "",
      assigned_employee_phone: "+16025559876",
      notes: "Premium $1,240/yr"
    });
    expect(log[0].table).toBe("business_documents");
    expect(log[0].calls.find((c) => c.name === "not")?.args).toEqual(["contact_id", "is", null]);
  });

  it("tolerates unresolvable ids and null data, and uses the default client", async () => {
    const { db } = makeDb([
      {
        data: [{ ...docRow, contact_id: "c-gone", assigned_employee_id: "m-gone", expires_at: "2027-06-01T00:00:00Z" }],
        error: null
      },
      { data: null, error: null },
      { data: null, error: null }
    ]);
    defaultClientSpy.mockReturnValue(db);
    const parsed = parseCsv(await exportDocumentsCsv(BIZ));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows[0]).toMatchObject({
      contact_phone: "",
      contact_name: "",
      assigned_employee_phone: "",
      expires_at: "2027-06-01"
    });
  });

  it("treats a null first page as an empty export and blanks unset fields", async () => {
    const { db } = makeDb([{ data: null, error: null }]);
    const parsed = parseCsv(await exportDocumentsCsv(BIZ, db));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows).toHaveLength(0);

    const { db: db2 } = makeDb([
      {
        data: [{ ...docRow, renewal_date: null, contact_id: "c-1", assigned_employee_id: null }],
        error: null
      },
      { data: [{ id: "c-1", customer_e164: "+16025551234", display_name: null }], error: null }
    ]);
    const parsed2 = parseCsv(await exportDocumentsCsv(BIZ, db2));
    expect(parsed2.ok).toBe(true);
    if (!parsed2.ok) return;
    expect(parsed2.rows[0]).toMatchObject({
      renewal_date: "",
      contact_phone: "+16025551234",
      contact_name: ""
    });
  });

  it("paginates past a full first page", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      ...docRow,
      title: `Policy ${i}`,
      contact_id: null,
      assigned_employee_id: null
    }));
    const { db, log } = makeDb([
      { data: fullPage, error: null },
      { data: [{ ...docRow, contact_id: null, assigned_employee_id: null }], error: null }
    ]);
    const parsed = parseCsv(await exportDocumentsCsv(BIZ, db));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows).toHaveLength(1001);
    expect(log[1].calls.find((c) => c.name === "range")?.args).toEqual([1000, 1999]);
  });

  it("throws on a page error and on directory errors", async () => {
    const pageErr = makeDb([{ data: null, error: { message: "page boom" } }]);
    await expect(exportDocumentsCsv(BIZ, pageErr.db)).rejects.toThrow(/page boom/);

    const contactErr = makeDb([
      { data: [docRow], error: null },
      { data: null, error: { message: "contacts boom" } }
    ]);
    await expect(exportDocumentsCsv(BIZ, contactErr.db)).rejects.toThrow(/contacts boom/);

    const memberErr = makeDb([
      { data: [docRow], error: null },
      { data: [CONTACT], error: null },
      { data: null, error: { message: "roster boom" } }
    ]);
    await expect(exportDocumentsCsv(BIZ, memberErr.db)).rejects.toThrow(/roster boom/);
  });
});

describe("importDocumentsCsv", () => {
  it("reports structurally broken CSV", async () => {
    const { db } = makeDb([]);
    const summary = await importDocumentsCsv(BIZ, '"unterminated', db);
    expect(summary.errors[0].row).toBe(0);
    expect(summary.totalRows).toBe(0);
  });

  it("requires the title and contact_phone columns", async () => {
    const { db } = makeDb([]);
    const noTitle = await importDocumentsCsv(BIZ, serializeCsv([["contact_phone"], ["+16025551234"]]), db);
    expect(noTitle.errors[0].message).toMatch(/"title"/);
    const noPhone = await importDocumentsCsv(BIZ, serializeCsv([["title"], ["Auto policy"]]), db);
    expect(noPhone.errors[0].message).toMatch(/"contact_phone"/);
  });

  it("caps the file at MAX_DOCUMENT_IMPORT_ROWS", async () => {
    const { db } = makeDb([]);
    const rows = Array.from({ length: MAX_DOCUMENT_IMPORT_ROWS + 1 }, (_, i) => [
      `Policy ${i}`,
      "+16025551234",
      "",
      "",
      "",
      "",
      "",
      ""
    ]);
    const summary = await importDocumentsCsv(BIZ, importCsv(rows), db);
    expect(summary.errors[0].message).toMatch(/Too many rows/);
  });

  it("aborts when the records pre-count fails", async () => {
    const { db } = makeDb([{ count: null, error: { message: "count boom" } }]);
    const summary = await importDocumentsCsv(
      BIZ,
      importCsv([["Auto policy", "+16025551234", "", "", "", "", "", ""]]),
      db
    );
    expect(summary.errors[0].message).toMatch(/count boom/);
    expect(summary.created).toBe(0);
  });

  it("skips rows with a missing title, bad phone, bad audience, or bad dates", async () => {
    const { db } = makeDb([{ count: 0, error: null }]);
    const summary = await importDocumentsCsv(
      BIZ,
      importCsv([
        ["", "+16025551234", "", "", "", "", "", ""],
        ["Auto policy", "not-a-phone", "", "", "", "", "", ""],
        ["Auto policy", "+16025551234", "", "", "", "", "everyone", ""],
        ["Auto policy", "+16025551234", "", "someday", "", "", "", ""],
        ["Auto policy", "+16025551234", "", "", "eventually", "", "", ""]
      ]),
      db
    );
    expect(summary.skipped).toBe(5);
    expect(summary.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/title is required/),
      expect.stringMatching(/contact_phone/),
      expect.stringMatching(/audience/),
      expect.stringMatching(/renewal_date/),
      expect.stringMatching(/expires_at/)
    ]);
  });

  it("requires the contact to exist and surfaces lookup errors", async () => {
    const missing = makeDb([{ count: 0, error: null }, { data: null, error: null }]);
    const summary = await importDocumentsCsv(
      BIZ,
      importCsv([["Auto policy", "+16025551234", "", "", "", "", "", ""]]),
      missing.db
    );
    expect(summary.errors[0].message).toMatch(/import your contacts first/);

    const lookupErr = makeDb([
      { count: 0, error: null },
      { data: null, error: { message: "contact boom" } }
    ]);
    const summary2 = await importDocumentsCsv(
      BIZ,
      importCsv([["Auto policy", "+16025551234", "", "", "", "", "", ""]]),
      lookupErr.db
    );
    expect(summary2.errors[0].message).toMatch(/contact boom/);
  });

  it("validates the assigned employee (bad number, unknown, lookup error)", async () => {
    const bad = makeDb([{ count: 0, error: null }, { data: CONTACT, error: null }]);
    const s1 = await importDocumentsCsv(
      BIZ,
      importCsv([["Auto policy", "+16025551234", "", "", "", "nope", "", ""]]),
      bad.db
    );
    expect(s1.errors[0].message).toMatch(/assigned_employee_phone/);

    const unknown = makeDb([
      { count: 0, error: null },
      { data: CONTACT, error: null },
      { data: null, error: null }
    ]);
    const s2 = await importDocumentsCsv(
      BIZ,
      importCsv([["Auto policy", "+16025551234", "", "", "", "+16025559876", "", ""]]),
      unknown.db
    );
    expect(s2.errors[0].message).toMatch(/no employee with number/);

    const lookupErr = makeDb([
      { count: 0, error: null },
      { data: CONTACT, error: null },
      { data: null, error: { message: "roster boom" } }
    ]);
    const s3 = await importDocumentsCsv(
      BIZ,
      importCsv([["Auto policy", "+16025551234", "", "", "", "+16025559876", "", ""]]),
      lookupErr.db
    );
    expect(s3.errors[0].message).toMatch(/roster boom/);
  });

  it("updates an existing record in place, re-arming reminder stamps on changed dates", async () => {
    const { db, log } = makeDb([
      { count: 3, error: null },
      { data: CONTACT, error: null },
      {
        data: [
          { id: "doc-1", renewal_date: "2027-01-01T23:59:59.999Z", expires_at: "2027-05-01T23:59:59.999Z" }
        ],
        error: null
      },
      { data: null, error: null }
    ]);
    const summary = await importDocumentsCsv(
      BIZ,
      importCsv([
        ["Auto policy", "+16025551234", "policy", "2027-03-01", "2027-06-01", "", "both", "New premium"]
      ]),
      db
    );
    expect(summary.updated).toBe(1);
    expect(summary.created).toBe(0);
    const updateTable = log.find((t) => t.calls.some((c) => c.name === "update"));
    const patch = updateTable?.calls.find((c) => c.name === "update")?.args[0] as Record<string, unknown>;
    expect(patch).toMatchObject({
      category: "policy",
      audience: "both",
      content_md: "New premium",
      renewal_date: "2027-03-01T23:59:59.999Z",
      renewal_due_notified_at: null,
      expires_at: "2027-06-01T23:59:59.999Z",
      expiring_soon_notified_at: null,
      expired_notified_at: null
    });
  });

  it("leaves unchanged dates alone on update and applies a new assignee only", async () => {
    const { db, log } = makeDb([
      { count: 3, error: null },
      { data: CONTACT, error: null },
      { data: { id: "m-1" }, error: null },
      {
        data: [
          { id: "doc-1", renewal_date: "2027-03-01T23:59:59.999Z", expires_at: "2027-06-01T23:59:59.999Z" }
        ],
        error: null
      },
      { data: null, error: null }
    ]);
    const summary = await importDocumentsCsv(
      BIZ,
      importCsv([
        ["Auto policy", "+16025551234", "", "2027-03-01", "2027-06-01", "+16025559876", "", ""]
      ]),
      db
    );
    expect(summary.updated).toBe(1);
    const updateTable = log.find((t) => t.calls.some((c) => c.name === "update"));
    const patch = updateTable?.calls.find((c) => c.name === "update")?.args[0] as Record<string, unknown>;
    expect(patch).toMatchObject({ assigned_employee_id: "m-1" });
    // Same instants → no re-arm, no content/category/audience churn.
    expect(patch).not.toHaveProperty("renewal_date");
    expect(patch).not.toHaveProperty("expires_at");
    expect(patch).not.toHaveProperty("content_md");
    expect(patch).not.toHaveProperty("category");
    expect(patch).not.toHaveProperty("audience");
  });

  it("imports with only the required headers, defaulting everything else", async () => {
    const { db, log } = makeDb([
      { count: null, error: null },
      { data: { id: "c-2", display_name: null, customer_e164: "+16025551234" }, error: null },
      { data: null, error: null },
      { data: null, error: null }
    ]);
    const summary = await importDocumentsCsv(
      BIZ,
      serializeCsv([
        ["title", "contact_phone"],
        ["Umbrella policy", "+16025551234"]
      ]),
      db
    );
    expect(summary.created).toBe(1);
    expect(summary.errors).toEqual([]);
    const insertTable = log.find((t) => t.calls.some((c) => c.name === "insert"));
    const inserted = insertTable?.calls.find((c) => c.name === "insert")?.args[0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      title: "Umbrella policy",
      category: "record",
      audience: "staff",
      contact_id: "c-2",
      renewal_date: null,
      expires_at: null,
      assigned_employee_id: null
    });
    // Nameless contact falls back to its number in the rendered summary.
    expect(String(inserted.content_md)).toContain("Contact: +16025551234");
  });

  it("refuses an ambiguous title match and surfaces update/lookup errors", async () => {
    const ambiguous = makeDb([
      { count: 0, error: null },
      { data: CONTACT, error: null },
      { data: [{ id: "d1" }, { id: "d2" }], error: null }
    ]);
    const s1 = await importDocumentsCsv(
      BIZ,
      importCsv([["Auto policy", "+16025551234", "", "", "", "", "", ""]]),
      ambiguous.db
    );
    expect(s1.errors[0].message).toMatch(/Multiple documents titled/);

    const existingErr = makeDb([
      { count: 0, error: null },
      { data: CONTACT, error: null },
      { data: null, error: { message: "match boom" } }
    ]);
    const s2 = await importDocumentsCsv(
      BIZ,
      importCsv([["Auto policy", "+16025551234", "", "", "", "", "", ""]]),
      existingErr.db
    );
    expect(s2.errors[0].message).toMatch(/match boom/);

    const updateErr = makeDb([
      { count: 0, error: null },
      { data: CONTACT, error: null },
      { data: [{ id: "d1", renewal_date: null, expires_at: null }], error: null },
      { data: null, error: { message: "update boom" } }
    ]);
    const s3 = await importDocumentsCsv(
      BIZ,
      importCsv([["Auto policy", "+16025551234", "", "", "", "", "", "notes"]]),
      updateErr.db
    );
    expect(s3.errors[0].message).toMatch(/update boom/);
  });

  it("creates a record with a synthesized original, defaulting audience to staff", async () => {
    const { db, log, storageCalls } = makeDb([
      { count: 0, error: null },
      { data: CONTACT, error: null },
      { data: [], error: null },
      { data: null, error: null } // insert result
    ]);
    const summary = await importDocumentsCsv(
      BIZ,
      importCsv([
        ["Auto policy #A-1042", "+16025551234", "policy", "2027-03-01", "", "", "", "Premium $1,240/yr."]
      ]),
      db
    );
    expect(summary.created).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(storageCalls[0].name).toBe("upload:business-docs");
    const insertTable = log.find((t) => t.calls.some((c) => c.name === "insert"));
    const inserted = insertTable?.calls.find((c) => c.name === "insert")?.args[0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      business_id: BIZ,
      title: "Auto policy #A-1042",
      category: "policy",
      audience: "staff",
      contact_id: "c-1",
      renewal_date: "2027-03-01T23:59:59.999Z",
      content_md: "Premium $1,240/yr.",
      status: "ready",
      mime_type: "text/markdown"
    });
  });

  it("renders a field summary when notes are blank and resolves the assignee", async () => {
    const { db, log } = makeDb([
      { count: 0, error: null },
      { data: CONTACT, error: null },
      { data: { id: "m-1" }, error: null },
      { data: [], error: null }
    ]);
    const summary = await importDocumentsCsv(
      BIZ,
      importCsv([
        ["Lease #7", "+16025551234", "", "2027-03-01", "2027-06-01", "+16025559876", "", ""]
      ]),
      db
    );
    expect(summary.created).toBe(1);
    const insertTable = log.find((t) => t.calls.some((c) => c.name === "insert"));
    const inserted = insertTable?.calls.find((c) => c.name === "insert")?.args[0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      category: "record",
      assigned_employee_id: "m-1"
    });
    expect(String(inserted.content_md)).toContain("# Lease #7");
    expect(String(inserted.content_md)).toContain("Renewal date: 2027-03-01");
    expect(String(inserted.content_md)).toContain("Expires: 2027-06-01");
    expect(String(inserted.content_md)).toContain("Contact: Jane Doe");
  });

  it("enforces the flat records cap across the file", async () => {
    const { db } = makeDb([
      { count: 2000, error: null },
      { data: CONTACT, error: null },
      { data: [], error: null }
    ]);
    const summary = await importDocumentsCsv(
      BIZ,
      importCsv([["Auto policy", "+16025551234", "", "", "", "", "", ""]]),
      db
    );
    expect(summary.errors[0].message).toMatch(/Contact document limit reached/);
  });

  it("reports a storage failure and compensates an insert failure", async () => {
    const uploadFail = makeDb(
      [
        { count: 0, error: null },
        { data: CONTACT, error: null },
        { data: [], error: null }
      ],
      [{ error: { message: "bucket down" } }]
    );
    const s1 = await importDocumentsCsv(
      BIZ,
      importCsv([["Auto policy", "+16025551234", "", "", "", "", "", ""]]),
      uploadFail.db
    );
    expect(s1.errors[0].message).toMatch(/bucket down/);

    const insertFail = makeDb(
      [
        { count: 0, error: null },
        { data: CONTACT, error: null },
        { data: [], error: null },
        { data: null, error: { message: "insert boom" } }
      ],
      [{ error: null }, { error: null }]
    );
    const s2 = await importDocumentsCsv(
      BIZ,
      importCsv([["Auto policy", "+16025551234", "", "", "", "", "", ""]]),
      insertFail.db
    );
    expect(s2.errors[0].message).toMatch(/insert boom/);
    expect(insertFail.storageCalls.map((c) => c.name)).toEqual([
      "upload:business-docs",
      "remove:business-docs"
    ]);

    const cleanupFail = makeDb(
      [
        { count: 0, error: null },
        { data: CONTACT, error: null },
        { data: [], error: null },
        { data: null, error: { message: "insert boom" } }
      ],
      [{ error: null }, { error: { message: "remove boom" } }]
    );
    const s3 = await importDocumentsCsv(
      BIZ,
      importCsv([["Auto policy", "+16025551234", "", "", "", "", "", ""]]),
      cleanupFail.db
    );
    expect(s3.errors[0].message).toMatch(/insert boom.*remove boom/);
  });

  it("tolerates non-Error throw values and uses the default client", async () => {
    const weirdFailure = "weird failure";
    const { db } = makeDb([
      { count: 0, error: null },
      () => {
        throw weirdFailure;
      }
    ]);
    defaultClientSpy.mockReturnValue(db);
    const summary = await importDocumentsCsv(
      BIZ,
      importCsv([["Auto policy", "+16025551234", "", "", "", "", "", ""]])
    );
    expect(summary.errors[0].message).toBe("Unexpected error");
  });
});
