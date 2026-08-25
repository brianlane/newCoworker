import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getCustomTableVersion,
  listBusinessCustomTableVersions,
  listCustomTableVersions,
  pruneCustomTableVersions,
  restoreCustomTableVersion
} from "@/lib/custom-tables/versions";
import {
  MAX_VERSIONS_PER_TABLE,
  type CustomTable,
  type CustomTableField
} from "@/lib/custom-tables/types";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/custom-tables/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/custom-tables/db")>(
    "@/lib/custom-tables/db"
  );
  return {
    ...actual,
    getCustomTable: vi.fn(),
    patchCustomTableFields: vi.fn(),
    restoreCustomTable: vi.fn(),
    updateCustomTableDetails: vi.fn(),
    updateCustomTableRow: vi.fn(),
    createCustomTableRow: vi.fn()
  };
});

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  createCustomTableRow,
  getCustomTable,
  patchCustomTableFields,
  restoreCustomTable,
  updateCustomTableDetails,
  updateCustomTableRow
} from "@/lib/custom-tables/db";

type Result = { data: unknown; error: unknown };

function chain(result: Result) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "delete", "eq", "lt", "order", "limit", "maybeSingle"]) {
    c[m] = vi.fn(() => c);
  }
  (c as { then: unknown }).then = (
    resolve: (v: Result) => unknown,
    reject: (e: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject);
  return c as Record<string, ReturnType<typeof vi.fn>> & PromiseLike<Result>;
}

function mockDb(queue: Result[]) {
  const remaining = [...queue];
  const chains: ReturnType<typeof chain>[] = [];
  const from = vi.fn((_table: string) => {
    const result =
      remaining.length > 1
        ? remaining.shift()!
        : (remaining[0] ?? { data: null, error: { message: "no mock" } });
    const c = chain(result);
    chains.push(c);
    return c;
  });
  return { from, chains };
}

function asClient(db: ReturnType<typeof mockDb>) {
  return db as unknown as Parameters<typeof listCustomTableVersions>[3];
}

const FIELD: CustomTableField = {
  id: "address",
  label: "Address",
  type: "text",
  required: false,
  enabled: true
};

const VERSION_ROW = {
  id: 5,
  table_id: "tbl-1",
  row_id: null as string | null,
  kind: "schema",
  name: "Properties",
  description: null as string | null,
  row_link: "standalone" as string | null,
  fields: [FIELD] as unknown,
  field_values: null as Record<string, unknown> | null,
  contact_id: null as string | null,
  source: "dashboard" as string | null,
  actor: null as string | null,
  replaced_at: "2026-08-20T00:00:00.000Z"
};

const TABLE: CustomTable = {
  id: "tbl-1",
  businessId: "biz-1",
  name: "Properties",
  description: null,
  icon: "home",
  rowLink: "standalone",
  fields: [FIELD],
  position: 0,
  deletedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z"
};

const EDIT = { source: "dashboard_restore" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCustomTable).mockResolvedValue(TABLE);
});

describe("listCustomTableVersions", () => {
  it("maps rows newest first, scoped to the business and the table", async () => {
    const db = mockDb([{ data: [VERSION_ROW], error: null }]);
    const [version] = await listCustomTableVersions("biz-1", "tbl-1", 20, asClient(db));
    expect(version).toMatchObject({ id: 5, kind: "schema", tableId: "tbl-1" });
    expect(version.fields).toEqual([FIELD]);
    expect(db.chains[0].eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(db.chains[0].eq).toHaveBeenCalledWith("table_id", "tbl-1");
  });

  it("keeps a null fields blob null, rather than turning it into an empty list", async () => {
    const db = mockDb([{ data: [{ ...VERSION_ROW, fields: null }], error: null }]);
    const [version] = await listCustomTableVersions("biz-1", "tbl-1", 20, asClient(db));
    expect(version.fields).toBeNull();
  });

  it("projects a row snapshot against the fields the snapshot carries", async () => {
    const db = mockDb([
      {
        data: [
          {
            ...VERSION_ROW,
            kind: "row_updated",
            row_id: "row-1",
            field_values: { address: "12 Maple St", ghost: "orphan" }
          }
        ],
        error: null
      }
    ]);
    const [version] = await listCustomTableVersions("biz-1", "tbl-1", 20, asClient(db));
    expect(version.values).toEqual({ address: "12 Maple St" });
  });

  it("projects a row snapshot with no field list against nothing", async () => {
    const db = mockDb([
      {
        data: [{ ...VERSION_ROW, kind: "row_deleted", fields: null, field_values: { a: 1 } }],
        error: null
      }
    ]);
    const [version] = await listCustomTableVersions("biz-1", "tbl-1", 20, asClient(db));
    expect(version.values).toEqual({});
  });

  it("defaults the limit, returns nothing for a null payload, and throws on failure", async () => {
    const db = mockDb([{ data: null, error: null }]);
    expect(await listCustomTableVersions("biz-1", "tbl-1", undefined, asClient(db))).toEqual([]);
    await expect(
      listCustomTableVersions("biz-1", "tbl-1", 20, asClient(mockDb([{ data: null, error: { message: "boom" } }])))
    ).rejects.toThrow("listCustomTableVersions: boom");
  });
});

describe("listBusinessCustomTableVersions", () => {
  it("spans every table of the business", async () => {
    const db = mockDb([{ data: [VERSION_ROW], error: null }]);
    const out = await listBusinessCustomTableVersions("biz-1", undefined, asClient(db));
    expect(out).toHaveLength(1);
    expect(db.chains[0].eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(db.chains[0].eq).not.toHaveBeenCalledWith("table_id", expect.anything());
  });

  it("returns nothing for a null payload and throws on failure", async () => {
    expect(
      await listBusinessCustomTableVersions("biz-1", 20, asClient(mockDb([{ data: null, error: null }])))
    ).toEqual([]);
    await expect(
      listBusinessCustomTableVersions("biz-1", 20, asClient(mockDb([{ data: null, error: { message: "x" } }])))
    ).rejects.toThrow("listBusinessCustomTableVersions: x");
  });
});

describe("getCustomTableVersion", () => {
  it("creates a client when none is injected", async () => {
    const db = mockDb([{ data: VERSION_ROW, error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(asClient(db) as never);
    const out = await getCustomTableVersion("biz-1", 5);
    expect(out.id).toBe(5);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });

  it("reports a pruned version as not_found and throws on failure", async () => {
    await expect(
      getCustomTableVersion("biz-1", 5, asClient(mockDb([{ data: null, error: null }])))
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      getCustomTableVersion("biz-1", 5, asClient(mockDb([{ data: null, error: { message: "x" } }])))
    ).rejects.toThrow("getCustomTableVersion: x");
  });
});

describe("restoreCustomTableVersion", () => {
  it("brings a deleted table back", async () => {
    const db = mockDb([{ data: { ...VERSION_ROW, kind: "table_deleted" }, error: null }]);
    const out = await restoreCustomTableVersion("biz-1", 5, EDIT, asClient(db));
    expect(out).toEqual({ kind: "table_restored" });
    expect(restoreCustomTable).toHaveBeenCalledWith("biz-1", "tbl-1", EDIT, expect.anything());
  });

  it("puts a schema snapshot back through the normal update path", async () => {
    const db = mockDb([{ data: VERSION_ROW, error: null }]);
    const out = await restoreCustomTableVersion("biz-1", 5, EDIT, asClient(db));
    expect(out).toEqual({ kind: "schema" });
    expect(updateCustomTableDetails).toHaveBeenCalledWith(
      "biz-1",
      "tbl-1",
      { name: "Properties", description: null },
      EDIT,
      expect.anything()
    );
    // The single column is already where the snapshot wants it, so there is
    // nothing to reorder.
    expect(patchCustomTableFields).not.toHaveBeenCalled();
  });

  it("passes undefined rather than null when the snapshot has no name", async () => {
    const db = mockDb([{ data: { ...VERSION_ROW, name: null }, error: null }]);
    await restoreCustomTableVersion("biz-1", 5, EDIT, asClient(db));
    expect(updateCustomTableDetails).toHaveBeenCalledWith(
      "biz-1",
      "tbl-1",
      { name: undefined, description: null },
      EDIT,
      expect.anything()
    );
  });

  it("reorders the columns back when the snapshot covers exactly the live set", async () => {
    const second = { ...FIELD, id: "city", label: "City" };
    vi.mocked(getCustomTable).mockResolvedValue({ ...TABLE, fields: [FIELD, second] });
    const db = mockDb([{ data: { ...VERSION_ROW, fields: [second, FIELD] }, error: null }]);
    await restoreCustomTableVersion("biz-1", 5, EDIT, asClient(db));
    expect(patchCustomTableFields).toHaveBeenCalledWith(
      "biz-1",
      "tbl-1",
      { action: "reorder", fieldIds: ["city", "address"] },
      EDIT,
      expect.anything()
    );
  });

  it("never resurrects a column the snapshot names but the table no longer has", async () => {
    // Restoring a DELETED column would bring back an empty column pretending
    // to be the old one, since removing it already swept its data. Only the
    // columns that still exist take part, and here that leaves the live
    // order unchanged, so there is nothing to write.
    const db = mockDb([
      { data: { ...VERSION_ROW, fields: [FIELD, { ...FIELD, id: "gone", label: "Gone" }] }, error: null }
    ]);
    await restoreCustomTableVersion("biz-1", 5, EDIT, asClient(db));
    expect(patchCustomTableFields).not.toHaveBeenCalled();
  });

  it("skips the reorder when a live column is missing from the snapshot", async () => {
    const second = { ...FIELD, id: "city", label: "City" };
    vi.mocked(getCustomTable).mockResolvedValue({ ...TABLE, fields: [second, FIELD] });
    const db = mockDb([{ data: { ...VERSION_ROW, fields: [FIELD] }, error: null }]);
    await restoreCustomTableVersion("biz-1", 5, EDIT, asClient(db));
    expect(patchCustomTableFields).not.toHaveBeenCalled();
  });

  it("does not reorder when the snapshot carried no columns at all", async () => {
    const db = mockDb([{ data: { ...VERSION_ROW, fields: [] }, error: null }]);
    await restoreCustomTableVersion("biz-1", 5, EDIT, asClient(db));
    expect(patchCustomTableFields).not.toHaveBeenCalled();
  });

  it("treats a null field list on a schema snapshot as no columns", async () => {
    const db = mockDb([{ data: { ...VERSION_ROW, fields: null }, error: null }]);
    await restoreCustomTableVersion("biz-1", 5, EDIT, asClient(db));
    expect(patchCustomTableFields).not.toHaveBeenCalled();
  });

  it("handles a table_restored snapshot the same way as a schema one", async () => {
    const db = mockDb([{ data: { ...VERSION_ROW, kind: "table_restored" }, error: null }]);
    expect(await restoreCustomTableVersion("biz-1", 5, EDIT, asClient(db))).toEqual({
      kind: "schema"
    });
  });

  it("puts a row edit back through the normal row update", async () => {
    const db = mockDb([
      {
        data: {
          ...VERSION_ROW,
          kind: "row_updated",
          row_id: "row-1",
          field_values: { address: "was" },
          contact_id: "c-1"
        },
        error: null
      }
    ]);
    const out = await restoreCustomTableVersion("biz-1", 5, EDIT, asClient(db));
    expect(out).toEqual({ kind: "row_updated", rowId: "row-1" });
    expect(updateCustomTableRow).toHaveBeenCalledWith(
      TABLE,
      "row-1",
      { values: { address: "was" }, contactId: "c-1" },
      EDIT,
      expect.anything()
    );
  });

  it("recreates a deleted row, with a new id, because the old one is gone", async () => {
    vi.mocked(createCustomTableRow).mockResolvedValue({
      id: "row-new",
      tableId: "tbl-1",
      contactId: null,
      values: { address: "was" },
      createdAt: "",
      updatedAt: ""
    });
    const db = mockDb([
      {
        data: { ...VERSION_ROW, kind: "row_deleted", row_id: "row-1", field_values: { address: "was" } },
        error: null
      }
    ]);
    const out = await restoreCustomTableVersion("biz-1", 5, EDIT, asClient(db));
    expect(out).toEqual({ kind: "row_recreated", rowId: "row-new" });
  });

  it("recreates rather than updates when a row_updated snapshot has no row id", async () => {
    vi.mocked(createCustomTableRow).mockResolvedValue({
      id: "row-new",
      tableId: "tbl-1",
      contactId: null,
      values: {},
      createdAt: "",
      updatedAt: ""
    });
    const db = mockDb([
      { data: { ...VERSION_ROW, kind: "row_updated", row_id: null, field_values: null }, error: null }
    ]);
    const out = await restoreCustomTableVersion("biz-1", 5, EDIT, asClient(db));
    expect(out).toEqual({ kind: "row_recreated", rowId: "row-new" });
    expect(createCustomTableRow).toHaveBeenCalledWith(
      "biz-1",
      TABLE,
      { values: {}, contactId: null },
      EDIT,
      expect.anything()
    );
  });
});

describe("pruneCustomTableVersions", () => {
  it("drops anything past the retention window", async () => {
    const db = mockDb([
      { data: [{ id: 1 }, { id: 2 }], error: null },
      { data: [{ id: 9 }], error: null }
    ]);
    const now = new Date("2026-12-01T00:00:00.000Z");
    expect(await pruneCustomTableVersions("tbl-1", now, asClient(db))).toBe(2);
    expect(db.chains[0].lt).toHaveBeenCalledWith("replaced_at", "2026-09-02T00:00:00.000Z");
  });

  it("also trims a table that churned inside the window", async () => {
    const kept = Array.from({ length: MAX_VERSIONS_PER_TABLE + 1 }, (_, i) => ({ id: 100 - i }));
    const db = mockDb([
      { data: [], error: null },
      { data: kept, error: null },
      { data: [{ id: 1 }, { id: 2 }, { id: 3 }], error: null }
    ]);
    expect(await pruneCustomTableVersions("tbl-1", new Date(), asClient(db))).toBe(3);
    expect(db.chains[2].lt).toHaveBeenCalledWith("id", kept[MAX_VERSIONS_PER_TABLE - 1].id);
  });

  it("leaves a short history alone", async () => {
    const db = mockDb([
      { data: [], error: null },
      { data: [{ id: 9 }], error: null }
    ]);
    expect(await pruneCustomTableVersions("tbl-1", new Date(), asClient(db))).toBe(0);
  });

  it("treats null payloads as nothing pruned", async () => {
    const db = mockDb([
      { data: null, error: null },
      { data: null, error: null }
    ]);
    expect(await pruneCustomTableVersions("tbl-1", new Date(), asClient(db))).toBe(0);
  });

  it("counts a null trim payload as nothing, having found an over-long history", async () => {
    const kept = Array.from({ length: MAX_VERSIONS_PER_TABLE + 1 }, (_, i) => ({ id: 100 - i }));
    const db = mockDb([
      { data: [], error: null },
      { data: kept, error: null },
      { data: null, error: null }
    ]);
    expect(await pruneCustomTableVersions("tbl-1", new Date(), asClient(db))).toBe(0);
  });

  it("defaults to now", async () => {
    const db = mockDb([
      { data: [], error: null },
      { data: [], error: null }
    ]);
    await expect(pruneCustomTableVersions("tbl-1", undefined, asClient(db))).resolves.toBe(0);
  });

  it("throws on either query failing", async () => {
    await expect(
      pruneCustomTableVersions("tbl-1", new Date(), asClient(mockDb([{ data: null, error: { message: "aged" } }])))
    ).rejects.toThrow("pruneCustomTableVersions: aged");
    await expect(
      pruneCustomTableVersions(
        "tbl-1",
        new Date(),
        asClient(mockDb([{ data: [], error: null }, { data: null, error: { message: "kept" } }]))
      )
    ).rejects.toThrow("pruneCustomTableVersions: kept");
    const kept = Array.from({ length: MAX_VERSIONS_PER_TABLE + 1 }, (_, i) => ({ id: 100 - i }));
    await expect(
      pruneCustomTableVersions(
        "tbl-1",
        new Date(),
        asClient(
          mockDb([
            { data: [], error: null },
            { data: kept, error: null },
            { data: null, error: { message: "trim" } }
          ])
        )
      )
    ).rejects.toThrow("pruneCustomTableVersions: trim");
  });
});
