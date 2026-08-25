import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CustomTableError,
  FIELD_SWEEP_PAGE_SIZE,
  countCustomTableRows,
  countRowsByTable,
  createCustomTable,
  createCustomTableRow,
  deleteCustomTableRow,
  deleteCustomTableRowsForContact,
  getCustomTable,
  getCustomTableRow,
  listCustomTableRows,
  listCustomTableRowsForContact,
  listCustomTableRowsWithContacts,
  listCustomTables,
  listDeletedCustomTables,
  patchCustomTableFields,
  purgeExpiredCustomTables,
  restoreCustomTable,
  softDeleteCustomTable,
  sweepRemovedFields,
  updateCustomTableDetails,
  updateCustomTableRow
} from "@/lib/custom-tables/db";
import {
  MAX_ROWS_PER_TABLE,
  MAX_TABLES_PER_BUSINESS,
  type CustomTable,
  type CustomTableField
} from "@/lib/custom-tables/types";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type Result = { data: unknown; error: unknown; count?: number | null };

/** Thenable PostgREST-chain stub (mirrors tests/todos-db.test.ts). */
function chain(result: Result) {
  const c: Record<string, unknown> = {};
  for (const m of [
    "select",
    "insert",
    "update",
    "delete",
    "eq",
    "in",
    "is",
    "not",
    "lt",
    "gt",
    "or",
    "order",
    "limit",
    "single",
    "maybeSingle"
  ]) {
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
  const tables: string[] = [];
  const from = vi.fn((table: string) => {
    tables.push(table);
    const result =
      remaining.length > 1
        ? remaining.shift()!
        : (remaining[0] ?? { data: null, error: { message: "no mock" } });
    const c = chain(result);
    chains.push(c);
    return c;
  });
  return { from, chains, tables };
}

type Db = ReturnType<typeof mockDb>;

/** Cast the stub to the client shape the db module expects. */
function asClient(db: Db) {
  return db as unknown as Parameters<typeof listCustomTables>[1];
}

const FIELD: CustomTableField = {
  id: "address",
  label: "Address",
  type: "text",
  required: false,
  enabled: true
};

const TABLE_ROW = {
  id: "tbl-1",
  business_id: "biz-1",
  name: "Properties",
  description: null as string | null,
  icon: "home",
  row_link: "standalone",
  fields: [FIELD],
  position: 0,
  deleted_at: null as string | null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-02T00:00:00.000Z"
};

const ROW_ROW = {
  id: "row-1",
  table_id: "tbl-1",
  contact_id: null as string | null,
  field_values: { address: "12 Maple St" } as Record<string, unknown> | null,
  created_at: "2026-08-03T00:00:00.000Z",
  updated_at: "2026-08-03T00:00:00.000Z"
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
  createdAt: TABLE_ROW.created_at,
  updatedAt: TABLE_ROW.updated_at
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolving the client", () => {
  it("creates one when the caller does not inject it", async () => {
    const db = mockDb([{ data: [TABLE_ROW], error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(asClient(db) as never);
    await listCustomTables("biz-1");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("uses the injected one without creating another", async () => {
    const db = mockDb([{ data: [TABLE_ROW], error: null }]);
    await listCustomTables("biz-1", asClient(db));
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});

describe("listCustomTables", () => {
  it("maps rows and filters to live tables", async () => {
    const db = mockDb([{ data: [TABLE_ROW], error: null }]);
    const tables = await listCustomTables("biz-1", asClient(db));
    expect(tables).toEqual([TABLE]);
    expect(db.chains[0].is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("clamps an unknown icon and an unknown row_link on the way out", async () => {
    const db = mockDb([
      { data: [{ ...TABLE_ROW, icon: "rocket", row_link: "sideways" }], error: null }
    ]);
    const [table] = await listCustomTables("biz-1", asClient(db));
    expect(table.icon).toBe("table");
    expect(table.rowLink).toBe("standalone");
  });

  it("reads a contact-linked table as such", async () => {
    const db = mockDb([{ data: [{ ...TABLE_ROW, row_link: "contact" }], error: null }]);
    const [table] = await listCustomTables("biz-1", asClient(db));
    expect(table.rowLink).toBe("contact");
  });

  it("returns nothing for a null payload", async () => {
    const db = mockDb([{ data: null, error: null }]);
    expect(await listCustomTables("biz-1", asClient(db))).toEqual([]);
  });

  it("throws a prefixed error on failure", async () => {
    const db = mockDb([{ data: null, error: { message: "boom" } }]);
    await expect(listCustomTables("biz-1", asClient(db))).rejects.toThrow(
      "listCustomTables: boom"
    );
  });
});

describe("listDeletedCustomTables", () => {
  it("asks only for trashed rows", async () => {
    const db = mockDb([{ data: [{ ...TABLE_ROW, deleted_at: "2026-08-10" }], error: null }]);
    const tables = await listDeletedCustomTables("biz-1", asClient(db));
    expect(tables[0].deletedAt).toBe("2026-08-10");
    expect(db.chains[0].not).toHaveBeenCalledWith("deleted_at", "is", null);
  });

  it("returns nothing for a null payload and throws on failure", async () => {
    expect(await listDeletedCustomTables("biz-1", asClient(mockDb([{ data: null, error: null }])))).toEqual([]);
    await expect(
      listDeletedCustomTables("biz-1", asClient(mockDb([{ data: null, error: { message: "no" } }])))
    ).rejects.toThrow("listDeletedCustomTables: no");
  });
});

describe("getCustomTable", () => {
  it("scopes to both the business and the id, so a URL cannot lie", async () => {
    const db = mockDb([{ data: TABLE_ROW, error: null }]);
    await getCustomTable("biz-1", "tbl-1", {}, asClient(db));
    expect(db.chains[0].eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(db.chains[0].eq).toHaveBeenCalledWith("id", "tbl-1");
    expect(db.chains[0].is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("can include a trashed table when asked", async () => {
    const db = mockDb([{ data: { ...TABLE_ROW, deleted_at: "2026-08-10" }, error: null }]);
    const table = await getCustomTable("biz-1", "tbl-1", { includeDeleted: true }, asClient(db));
    expect(table.deletedAt).toBe("2026-08-10");
    expect(db.chains[0].is).not.toHaveBeenCalled();
  });

  it("reports a missing table as not_found, and a query failure as an error", async () => {
    await expect(
      getCustomTable("biz-1", "tbl-1", {}, asClient(mockDb([{ data: null, error: null }])))
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      getCustomTable("biz-1", "tbl-1", {}, asClient(mockDb([{ data: null, error: { message: "x" } }])))
    ).rejects.toThrow("getCustomTable: x");
  });
});

describe("createCustomTable", () => {
  const input = { name: "  Properties  ", fields: [FIELD] };

  it("inserts with a trimmed name, a clamped icon, and the next position", async () => {
    const db = mockDb([
      { data: [{ ...TABLE_ROW, id: "other", name: "Vehicles" }], error: null },
      { data: TABLE_ROW, error: null }
    ]);
    const created = await createCustomTable(
      "biz-1",
      { ...input, description: "  Listings  ", icon: "rocket", rowLink: "contact", createdBy: "user-1" },
      asClient(db)
    );
    expect(created).toEqual(TABLE);
    expect(db.chains[1].insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-1",
        name: "Properties",
        description: "Listings",
        icon: "table",
        row_link: "contact",
        position: 1,
        created_by: "user-1"
      })
    );
  });

  it("defaults description, row link, and creator when they are absent", async () => {
    const db = mockDb([
      { data: [], error: null },
      { data: TABLE_ROW, error: null }
    ]);
    await createCustomTable("biz-1", input, asClient(db));
    expect(db.chains[1].insert).toHaveBeenCalledWith(
      expect.objectContaining({ description: null, row_link: "standalone", created_by: null, position: 0 })
    );
  });

  it("refuses at the table cap", async () => {
    const many = Array.from({ length: MAX_TABLES_PER_BUSINESS }, (_, i) => ({
      ...TABLE_ROW,
      id: `t${i}`,
      name: `T${i}`
    }));
    const db = mockDb([{ data: many, error: null }]);
    await expect(createCustomTable("biz-1", input, asClient(db))).rejects.toMatchObject({
      code: "limit"
    });
  });

  it("refuses a duplicate name before the insert, case-insensitively", async () => {
    const db = mockDb([{ data: [{ ...TABLE_ROW, name: "properties" }], error: null }]);
    await expect(createCustomTable("biz-1", input, asClient(db))).rejects.toMatchObject({
      code: "duplicate"
    });
  });

  it("maps the unique-index violation to duplicate, which is the real race", async () => {
    const db = mockDb([
      { data: [], error: null },
      { data: null, error: { code: "23505", message: "dupe" } }
    ]);
    await expect(createCustomTable("biz-1", input, asClient(db))).rejects.toMatchObject({
      code: "duplicate"
    });
  });

  it("throws on any other insert error, and on an empty insert result", async () => {
    await expect(
      createCustomTable(
        "biz-1",
        input,
        asClient(mockDb([{ data: [], error: null }, { data: null, error: { message: "nope" } }]))
      )
    ).rejects.toThrow("createCustomTable: nope");
    await expect(
      createCustomTable(
        "biz-1",
        input,
        asClient(mockDb([{ data: [], error: null }, { data: null, error: null }]))
      )
    ).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("updateCustomTableDetails", () => {
  it("writes only the supplied fields, plus the edit carrier", async () => {
    const db = mockDb([{ data: TABLE_ROW, error: null }]);
    await updateCustomTableDetails(
      "biz-1",
      "tbl-1",
      { name: "  Listings  ", description: "  desc  ", icon: "home" },
      { source: "dashboard", actor: "owner@example.com" },
      asClient(db)
    );
    expect(db.chains[0].update).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Listings",
        description: "desc",
        icon: "home",
        edit_source: "dashboard",
        edit_actor: "owner@example.com"
      })
    );
  });

  it("nulls a blank description and nulls the carrier when unstamped", async () => {
    const db = mockDb([{ data: TABLE_ROW, error: null }]);
    await updateCustomTableDetails("biz-1", "tbl-1", { description: "   " }, undefined, asClient(db));
    const patch = db.chains[0].update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.description).toBeNull();
    expect(patch.edit_source).toBeNull();
    expect(patch.edit_actor).toBeNull();
    expect(patch).not.toHaveProperty("name");
  });

  it("maps a unique violation to duplicate, and a miss to not_found", async () => {
    await expect(
      updateCustomTableDetails(
        "biz-1",
        "tbl-1",
        { name: "Taken" },
        undefined,
        asClient(mockDb([{ data: null, error: { code: "23505", message: "dupe" } }]))
      )
    ).rejects.toMatchObject({ code: "duplicate" });
    await expect(
      updateCustomTableDetails(
        "biz-1",
        "tbl-1",
        {},
        undefined,
        asClient(mockDb([{ data: null, error: null }]))
      )
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("throws on any other error", async () => {
    await expect(
      updateCustomTableDetails(
        "biz-1",
        "tbl-1",
        {},
        undefined,
        asClient(mockDb([{ data: null, error: { message: "boom" } }]))
      )
    ).rejects.toThrow("updateCustomTableDetails: boom");
  });
});

describe("patchCustomTableFields", () => {
  it("adds a column, pinning the write to the loaded updated_at", async () => {
    const db = mockDb([
      { data: TABLE_ROW, error: null },
      { data: TABLE_ROW, error: null }
    ]);
    const out = await patchCustomTableFields(
      "biz-1",
      "tbl-1",
      { action: "add", label: "Price", type: "number" },
      { source: "dashboard" },
      asClient(db)
    );
    expect(out.sweptRows).toBe(0);
    expect(db.chains[1].eq).toHaveBeenCalledWith("updated_at", TABLE_ROW.updated_at);
  });

  it("removes a column and sweeps its key out of every row", async () => {
    const db = mockDb([
      { data: TABLE_ROW, error: null },
      { data: TABLE_ROW, error: null },
      { data: [{ id: "row-1", field_values: { address: "12 Maple St" } }], error: null },
      { data: null, error: null }
    ]);
    const out = await patchCustomTableFields(
      "biz-1",
      "tbl-1",
      { action: "remove", fieldId: "address" },
      undefined,
      asClient(db)
    );
    expect(out.sweptRows).toBe(1);
  });

  it.each([
    [{ action: "remove" as const, fieldId: "ghost" }, "not_found"],
    [{ action: "add" as const, label: "Address", type: "text" as const }, "duplicate"],
    [{ action: "reorder" as const, fieldIds: ["nope"] }, "invalid"]
  ])("relays a rejected patch as %s", async (patch, code) => {
    const db = mockDb([{ data: TABLE_ROW, error: null }]);
    await expect(
      patchCustomTableFields("biz-1", "tbl-1", patch, undefined, asClient(db))
    ).rejects.toMatchObject({ code });
  });

  it("relays the column cap as limit", async () => {
    const full = Array.from({ length: 20 }, (_, i) => ({ ...FIELD, id: `f${i}`, label: `F${i}` }));
    const db = mockDb([{ data: { ...TABLE_ROW, fields: full }, error: null }]);
    await expect(
      patchCustomTableFields(
        "biz-1",
        "tbl-1",
        { action: "add", label: "One more", type: "text" },
        undefined,
        asClient(db)
      )
    ).rejects.toMatchObject({ code: "limit" });
  });

  it("tells the loser of a concurrent column edit to reload, instead of losing their work", async () => {
    const db = mockDb([
      { data: TABLE_ROW, error: null },
      { data: null, error: null }
    ]);
    await expect(
      patchCustomTableFields(
        "biz-1",
        "tbl-1",
        { action: "add", label: "Price", type: "number" },
        undefined,
        asClient(db)
      )
    ).rejects.toThrow(/changed this table's columns/);
  });

  it("throws on a write failure", async () => {
    const db = mockDb([
      { data: TABLE_ROW, error: null },
      { data: null, error: { message: "boom" } }
    ]);
    await expect(
      patchCustomTableFields(
        "biz-1",
        "tbl-1",
        { action: "add", label: "Price", type: "number" },
        undefined,
        asClient(db)
      )
    ).rejects.toThrow("patchCustomTableFields: boom");
  });
});

describe("softDeleteCustomTable", () => {
  it("stamps deleted_at and the deleter", async () => {
    const db = mockDb([{ data: { id: "tbl-1" }, error: null }]);
    await softDeleteCustomTable("biz-1", "tbl-1", "user-1", { source: "ai_dashboard" }, asClient(db));
    const patch = db.chains[0].update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.deleted_by).toBe("user-1");
    expect(patch.deleted_at).toEqual(expect.any(String));
    expect(patch.edit_source).toBe("ai_dashboard");
  });

  it("reports an already-deleted table as not_found, and throws on failure", async () => {
    await expect(
      softDeleteCustomTable("biz-1", "tbl-1", null, undefined, asClient(mockDb([{ data: null, error: null }])))
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      softDeleteCustomTable(
        "biz-1",
        "tbl-1",
        null,
        undefined,
        asClient(mockDb([{ data: null, error: { message: "boom" } }]))
      )
    ).rejects.toThrow("softDeleteCustomTable: boom");
  });
});

describe("restoreCustomTable", () => {
  const trashed = { ...TABLE_ROW, deleted_at: "2026-08-10T00:00:00.000Z" };

  it("clears the stamp", async () => {
    const db = mockDb([
      { data: trashed, error: null },
      { data: [], error: null },
      { data: TABLE_ROW, error: null }
    ]);
    const restored = await restoreCustomTable("biz-1", "tbl-1", { source: "dashboard_restore" }, asClient(db));
    expect(restored.deletedAt).toBeNull();
    const patch = db.chains[2].update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.deleted_at).toBeNull();
    expect(patch.deleted_by).toBeNull();
  });

  it("is a no-op for a table that was never deleted", async () => {
    const db = mockDb([{ data: TABLE_ROW, error: null }]);
    const out = await restoreCustomTable("biz-1", "tbl-1", undefined, asClient(db));
    expect(out).toEqual(TABLE);
    expect(db.from).toHaveBeenCalledTimes(1);
  });

  it("refuses when restoring would exceed the table cap", async () => {
    const many = Array.from({ length: MAX_TABLES_PER_BUSINESS }, (_, i) => ({
      ...TABLE_ROW,
      id: `t${i}`,
      name: `T${i}`
    }));
    const db = mockDb([
      { data: trashed, error: null },
      { data: many, error: null }
    ]);
    await expect(restoreCustomTable("biz-1", "tbl-1", undefined, asClient(db))).rejects.toMatchObject({
      code: "limit"
    });
  });

  it("explains the name clash instead of leaking a unique-index error", async () => {
    const db = mockDb([
      { data: trashed, error: null },
      { data: [{ ...TABLE_ROW, id: "other", name: "properties" }], error: null }
    ]);
    await expect(restoreCustomTable("biz-1", "tbl-1", undefined, asClient(db))).rejects.toThrow(
      /Rename it before restoring/
    );
  });

  it("maps a racing unique violation to the same explanation", async () => {
    const db = mockDb([
      { data: trashed, error: null },
      { data: [], error: null },
      { data: null, error: { code: "23505", message: "dupe" } }
    ]);
    await expect(restoreCustomTable("biz-1", "tbl-1", undefined, asClient(db))).rejects.toMatchObject({
      code: "duplicate"
    });
  });

  it("throws on any other error, and reports a vanished table", async () => {
    await expect(
      restoreCustomTable(
        "biz-1",
        "tbl-1",
        undefined,
        asClient(
          mockDb([
            { data: trashed, error: null },
            { data: [], error: null },
            { data: null, error: { message: "boom" } }
          ])
        )
      )
    ).rejects.toThrow("restoreCustomTable: boom");
    await expect(
      restoreCustomTable(
        "biz-1",
        "tbl-1",
        undefined,
        asClient(
          mockDb([
            { data: trashed, error: null },
            { data: [], error: null },
            { data: null, error: null }
          ])
        )
      )
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("sweepRemovedFields", () => {
  it("does nothing when no column went away", async () => {
    const db = mockDb([{ data: null, error: null }]);
    expect(await sweepRemovedFields("tbl-1", [], asClient(db))).toBe(0);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("skips rows that never held the key", async () => {
    const db = mockDb([{ data: [{ id: "row-1", field_values: { other: 1 } }], error: null }]);
    expect(await sweepRemovedFields("tbl-1", ["gone"], asClient(db))).toBe(0);
  });

  it("treats a null value bag as empty", async () => {
    const db = mockDb([{ data: [{ id: "row-1", field_values: null }], error: null }]);
    expect(await sweepRemovedFields("tbl-1", ["gone"], asClient(db))).toBe(0);
  });

  it("strips the key and counts the row", async () => {
    const db = mockDb([
      { data: [{ id: "row-1", field_values: { gone: "x", kept: "y" } }], error: null },
      { data: null, error: null }
    ]);
    expect(await sweepRemovedFields("tbl-1", ["gone"], asClient(db))).toBe(1);
    expect(db.chains[1].update).toHaveBeenCalledWith(
      expect.objectContaining({ field_values: { kept: "y" } })
    );
  });

  it("pages until a short page, keysetting on the last id", async () => {
    const fullPage = Array.from({ length: FIELD_SWEEP_PAGE_SIZE }, (_, i) => ({
      id: `row-${i}`,
      field_values: {}
    }));
    const db = mockDb([
      { data: fullPage, error: null },
      { data: [], error: null }
    ]);
    await sweepRemovedFields("tbl-1", ["gone"], asClient(db));
    expect(db.chains[1].gt).toHaveBeenCalledWith("id", `row-${FIELD_SWEEP_PAGE_SIZE - 1}`);
  });

  it("returns nothing for a null page", async () => {
    const db = mockDb([{ data: null, error: null }]);
    expect(await sweepRemovedFields("tbl-1", ["gone"], asClient(db))).toBe(0);
  });

  it("throws on a read failure and on an update failure", async () => {
    await expect(
      sweepRemovedFields("tbl-1", ["gone"], asClient(mockDb([{ data: null, error: { message: "read" } }])))
    ).rejects.toThrow("sweepRemovedFields: read");
    await expect(
      sweepRemovedFields(
        "tbl-1",
        ["gone"],
        asClient(
          mockDb([
            { data: [{ id: "row-1", field_values: { gone: 1 } }], error: null },
            { data: null, error: { message: "write" } }
          ])
        )
      )
    ).rejects.toThrow("sweepRemovedFields: update: write");
  });
});

describe("purgeExpiredCustomTables", () => {
  it("deletes past the retention window and counts what went", async () => {
    const db = mockDb([{ data: [{ id: "tbl-1" }, { id: "tbl-2" }], error: null }]);
    const now = new Date("2026-09-30T00:00:00.000Z");
    expect(await purgeExpiredCustomTables(now, asClient(db))).toBe(2);
    expect(db.chains[0].lt).toHaveBeenCalledWith("deleted_at", "2026-08-31T00:00:00.000Z");
  });

  it("counts nothing for a null payload and throws on failure", async () => {
    expect(await purgeExpiredCustomTables(new Date(), asClient(mockDb([{ data: null, error: null }])))).toBe(0);
    await expect(
      purgeExpiredCustomTables(new Date(), asClient(mockDb([{ data: null, error: { message: "boom" } }])))
    ).rejects.toThrow("purgeExpiredCustomTables: boom");
  });

  it("defaults to now", async () => {
    const db = mockDb([{ data: [], error: null }]);
    await expect(purgeExpiredCustomTables(undefined, asClient(db))).resolves.toBe(0);
  });
});

describe("countCustomTableRows", () => {
  it("returns the head count, or zero when there is none", async () => {
    expect(
      await countCustomTableRows("tbl-1", asClient(mockDb([{ data: null, error: null, count: 7 }])))
    ).toBe(7);
    expect(
      await countCustomTableRows("tbl-1", asClient(mockDb([{ data: null, error: null, count: null }])))
    ).toBe(0);
  });

  it("throws on failure", async () => {
    await expect(
      countCustomTableRows("tbl-1", asClient(mockDb([{ data: null, error: { message: "boom" } }])))
    ).rejects.toThrow("countCustomTableRows: boom");
  });
});

describe("listCustomTableRows", () => {
  it("maps rows, projecting away orphan keys", async () => {
    const db = mockDb([
      { data: [{ ...ROW_ROW, field_values: { address: "12 Maple St", ghost: "orphan" } }], error: null }
    ]);
    const out = await listCustomTableRows("tbl-1", [FIELD], {}, asClient(db));
    expect(out.rows[0].values).toEqual({ address: "12 Maple St" });
    expect(out.nextCursor).toBeNull();
  });

  it("returns a cursor carrying BOTH halves of the sort key", async () => {
    // A bulk insert gives every row the same now(), so a cursor of
    // created_at alone would skip or repeat the rest of that timestamp.
    const rows = [
      { ...ROW_ROW, id: "row-1", created_at: "2026-08-05T00:00:00.000Z" },
      { ...ROW_ROW, id: "row-2", created_at: "2026-08-05T00:00:00.000Z" }
    ];
    const out = await listCustomTableRows(
      "tbl-1",
      [FIELD],
      { limit: 1 },
      asClient(mockDb([{ data: rows, error: null }]))
    );
    expect(out.rows).toHaveLength(1);
    expect(out.nextCursor).toBe("2026-08-05T00:00:00.000Z|row-1");
  });

  it("filters by contact and pages strictly after the compound cursor", async () => {
    const db = mockDb([{ data: [], error: null }]);
    await listCustomTableRows(
      "tbl-1",
      [FIELD],
      { contactId: "c-1", cursor: "2026-08-05T00:00:00.000Z|row-1" },
      asClient(db)
    );
    expect(db.chains[0].eq).toHaveBeenCalledWith("contact_id", "c-1");
    expect(db.chains[0].or).toHaveBeenCalledWith(
      "created_at.lt.2026-08-05T00:00:00.000Z,and(created_at.eq.2026-08-05T00:00:00.000Z,id.lt.row-1)"
    );
  });

  it.each([
    ["no separator", "2026-08-05T00:00:00.000Z"],
    ["nothing before it", "|row-1"],
    ["nothing after it", "2026-08-05T00:00:00.000Z|"]
  ])("ignores a malformed cursor with %s rather than paging wrongly", async (_label, cursor) => {
    const db = mockDb([{ data: [], error: null }]);
    await listCustomTableRows("tbl-1", [FIELD], { cursor }, asClient(db));
    expect(db.chains[0].or).not.toHaveBeenCalled();
  });

  it("returns nothing for a null payload and throws on failure", async () => {
    const empty = await listCustomTableRows("tbl-1", [FIELD], {}, asClient(mockDb([{ data: null, error: null }])));
    expect(empty).toEqual({ rows: [], nextCursor: null });
    await expect(
      listCustomTableRows("tbl-1", [FIELD], {}, asClient(mockDb([{ data: null, error: { message: "boom" } }])))
    ).rejects.toThrow("listCustomTableRows: boom");
  });

  it("defaults the options bag", async () => {
    const db = mockDb([{ data: [], error: null }]);
    await expect(listCustomTableRows("tbl-1", [FIELD], undefined, asClient(db))).resolves.toEqual({
      rows: [],
      nextCursor: null
    });
  });
});

describe("listCustomTableRowsWithContacts", () => {
  it("joins names for the rows that point at someone", async () => {
    const db = mockDb([
      { data: [{ ...ROW_ROW, contact_id: "c-1" }, { ...ROW_ROW, id: "row-2", contact_id: null }], error: null },
      { data: [{ id: "c-1", display_name: "Maria", customer_e164: "+15551230000" }], error: null }
    ]);
    const out = await listCustomTableRowsWithContacts("biz-1", "tbl-1", [FIELD], {}, asClient(db));
    expect(out.rows[0]).toMatchObject({ contactName: "Maria", contactE164: "+15551230000" });
    expect(out.rows[1]).toMatchObject({ contactName: null, contactE164: null });
  });

  it("leaves a name null when the contact lookup misses that row", async () => {
    const db = mockDb([
      { data: [{ ...ROW_ROW, contact_id: "c-gone" }], error: null },
      { data: [], error: null }
    ]);
    const out = await listCustomTableRowsWithContacts("biz-1", "tbl-1", [FIELD], {}, asClient(db));
    expect(out.rows[0]).toMatchObject({ contactName: null, contactE164: null });
  });

  it("skips the contact query entirely when no row points at anyone", async () => {
    const db = mockDb([{ data: [ROW_ROW], error: null }]);
    await listCustomTableRowsWithContacts("biz-1", "tbl-1", [FIELD], {}, asClient(db));
    expect(db.from).toHaveBeenCalledTimes(1);
  });

  it("throws when the contact lookup fails", async () => {
    const db = mockDb([
      { data: [{ ...ROW_ROW, contact_id: "c-1" }], error: null },
      { data: null, error: { message: "boom" } }
    ]);
    await expect(
      listCustomTableRowsWithContacts("biz-1", "tbl-1", [FIELD], {}, asClient(db))
    ).rejects.toThrow("listCustomTableRowsWithContacts: boom");
  });

  it("treats a null contact payload as no names", async () => {
    const db = mockDb([
      { data: [{ ...ROW_ROW, contact_id: "c-1" }], error: null },
      { data: null, error: null }
    ]);
    const out = await listCustomTableRowsWithContacts("biz-1", "tbl-1", [FIELD], undefined, asClient(db));
    expect(out.rows[0].contactName).toBeNull();
  });
});

describe("listCustomTableRowsForContact", () => {
  it("returns nothing when the business has no contact-linked tables", async () => {
    const db = mockDb([{ data: [TABLE_ROW], error: null }]);
    expect(await listCustomTableRowsForContact("biz-1", "c-1", asClient(db))).toEqual([]);
    expect(db.from).toHaveBeenCalledTimes(1);
  });

  it("groups rows under their table and drops tables with none", async () => {
    const linked = { ...TABLE_ROW, row_link: "contact" };
    const other = { ...TABLE_ROW, id: "tbl-2", name: "Policies", row_link: "contact" };
    const db = mockDb([
      { data: [linked, other], error: null },
      { data: [{ ...ROW_ROW, contact_id: "c-1" }], error: null }
    ]);
    const out = await listCustomTableRowsForContact("biz-1", "c-1", asClient(db));
    expect(out).toHaveLength(1);
    expect(out[0].table.id).toBe("tbl-1");
    expect(out[0].rows).toHaveLength(1);
  });

  it("treats a null row payload as none, and throws on failure", async () => {
    const linked = { ...TABLE_ROW, row_link: "contact" };
    expect(
      await listCustomTableRowsForContact(
        "biz-1",
        "c-1",
        asClient(mockDb([{ data: [linked], error: null }, { data: null, error: null }]))
      )
    ).toEqual([]);
    await expect(
      listCustomTableRowsForContact(
        "biz-1",
        "c-1",
        asClient(mockDb([{ data: [linked], error: null }, { data: null, error: { message: "boom" } }]))
      )
    ).rejects.toThrow("listCustomTableRowsForContact: boom");
  });
});

describe("getCustomTableRow", () => {
  it("scopes to the table as well as the row", async () => {
    const db = mockDb([{ data: ROW_ROW, error: null }]);
    await getCustomTableRow("tbl-1", "row-1", [FIELD], asClient(db));
    expect(db.chains[0].eq).toHaveBeenCalledWith("table_id", "tbl-1");
    expect(db.chains[0].eq).toHaveBeenCalledWith("id", "row-1");
  });

  it("reports a miss as not_found and throws on failure", async () => {
    await expect(
      getCustomTableRow("tbl-1", "row-1", [FIELD], asClient(mockDb([{ data: null, error: null }])))
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      getCustomTableRow("tbl-1", "row-1", [FIELD], asClient(mockDb([{ data: null, error: { message: "x" } }])))
    ).rejects.toThrow("getCustomTableRow: x");
  });
});

describe("createCustomTableRow", () => {
  it("inserts the validated values with the edit carrier", async () => {
    const db = mockDb([
      { data: null, error: null, count: 3 },
      { data: ROW_ROW, error: null }
    ]);
    const row = await createCustomTableRow(
      "biz-1",
      TABLE,
      { values: { address: "12 Maple St" }, contactId: "c-1", createdBy: "user-1" },
      { source: "ai_dashboard", actor: "+15550001111" },
      asClient(db)
    );
    expect(row.values).toEqual({ address: "12 Maple St" });
    expect(db.chains[1].insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-1",
        table_id: "tbl-1",
        contact_id: "c-1",
        created_by: "user-1",
        edit_source: "ai_dashboard"
      })
    );
  });

  it("defaults the contact and creator to null", async () => {
    const db = mockDb([
      { data: null, error: null, count: 0 },
      { data: ROW_ROW, error: null }
    ]);
    await createCustomTableRow("biz-1", TABLE, { values: {} }, undefined, asClient(db));
    expect(db.chains[1].insert).toHaveBeenCalledWith(
      expect.objectContaining({ contact_id: null, created_by: null })
    );
  });

  it("refuses at the row cap, naming the table", async () => {
    const db = mockDb([{ data: null, error: null, count: MAX_ROWS_PER_TABLE }]);
    await expect(
      createCustomTableRow("biz-1", TABLE, { values: {} }, undefined, asClient(db))
    ).rejects.toThrow(/"Properties" is at 5000 rows/);
  });

  it("throws on an insert failure and on an empty result", async () => {
    await expect(
      createCustomTableRow(
        "biz-1",
        TABLE,
        { values: {} },
        undefined,
        asClient(mockDb([{ data: null, error: null, count: 0 }, { data: null, error: { message: "boom" } }]))
      )
    ).rejects.toThrow("createCustomTableRow: boom");
    await expect(
      createCustomTableRow(
        "biz-1",
        TABLE,
        { values: {} },
        undefined,
        asClient(mockDb([{ data: null, error: null, count: 0 }, { data: null, error: null }]))
      )
    ).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("updateCustomTableRow", () => {
  it("clears the cells the writer explicitly blanked", async () => {
    const two = [FIELD, { ...FIELD, id: "city", label: "City" }];
    const table = { ...TABLE, fields: two };
    const db = mockDb([
      { data: { ...ROW_ROW, field_values: { address: "12 Maple St", city: "Phoenix" } }, error: null },
      { data: ROW_ROW, error: null }
    ]);
    await updateCustomTableRow(table, "row-1", { values: {}, clear: ["city"] }, undefined, asClient(db));
    expect(db.chains[1].update).toHaveBeenCalledWith(
      expect.objectContaining({ field_values: { address: "12 Maple St" } })
    );
  });

  it("replaces the whole bag when asked, which is what an undo needs", async () => {
    const two = [FIELD, { ...FIELD, id: "city", label: "City" }];
    const table = { ...TABLE, fields: two };
    const db = mockDb([
      { data: { ...ROW_ROW, field_values: { address: "12 Maple St", city: "added later" } }, error: null },
      { data: ROW_ROW, error: null }
    ]);
    await updateCustomTableRow(
      table,
      "row-1",
      { values: { address: "12 Maple St" }, replace: true },
      undefined,
      asClient(db)
    );
    expect(db.chains[1].update).toHaveBeenCalledWith(
      expect.objectContaining({ field_values: { address: "12 Maple St" } })
    );
  });

  it("merges values rather than replacing the bag", async () => {
    const two = [FIELD, { ...FIELD, id: "city", label: "City" }];
    const table = { ...TABLE, fields: two };
    const db = mockDb([
      { data: { ...ROW_ROW, field_values: { address: "12 Maple St", city: "Phoenix" } }, error: null },
      { data: ROW_ROW, error: null }
    ]);
    await updateCustomTableRow(table, "row-1", { values: { city: "Tempe" } }, undefined, asClient(db));
    expect(db.chains[1].update).toHaveBeenCalledWith(
      expect.objectContaining({ field_values: { address: "12 Maple St", city: "Tempe" } })
    );
  });

  it("can unlink a contact without touching the values", async () => {
    const db = mockDb([
      { data: ROW_ROW, error: null },
      { data: ROW_ROW, error: null }
    ]);
    await updateCustomTableRow(TABLE, "row-1", { contactId: null }, undefined, asClient(db));
    const patch = db.chains[1].update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.contact_id).toBeNull();
    expect(patch).not.toHaveProperty("field_values");
  });

  it("reports a vanished row as not_found and throws on failure", async () => {
    await expect(
      updateCustomTableRow(
        TABLE,
        "row-1",
        {},
        undefined,
        asClient(mockDb([{ data: ROW_ROW, error: null }, { data: null, error: null }]))
      )
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      updateCustomTableRow(
        TABLE,
        "row-1",
        {},
        undefined,
        asClient(mockDb([{ data: ROW_ROW, error: null }, { data: null, error: { message: "boom" } }]))
      )
    ).rejects.toThrow("updateCustomTableRow: boom");
  });
});

describe("deleteCustomTableRow", () => {
  it("deletes first, then labels the version row the trigger just wrote", async () => {
    // Pre-stamping cannot work: the stamping UPDATE fires the update
    // trigger, which consumes the carrier, so the delete would always be
    // unattributed. Proven against a real Postgres.
    const db = mockDb([
      { data: { id: "row-1" }, error: null },
      { data: null, error: null }
    ]);
    await deleteCustomTableRow("tbl-1", "row-1", { source: "ai_dashboard" }, asClient(db));
    expect(db.tables).toEqual(["custom_table_rows", "custom_table_versions"]);
    expect(db.chains[1].update).toHaveBeenCalledWith({
      source: "ai_dashboard",
      actor: null
    });
    // Only the snapshot this delete wrote, never an older one.
    expect(db.chains[1].eq).toHaveBeenCalledWith("kind", "row_deleted");
    expect(db.chains[1].is).toHaveBeenCalledWith("source", null);
  });

  it("carries an actor through to the label", async () => {
    const db = mockDb([
      { data: { id: "row-1" }, error: null },
      { data: null, error: null }
    ]);
    await deleteCustomTableRow(
      "tbl-1",
      "row-1",
      { source: "ai_sms", actor: "+15550001111" },
      asClient(db)
    );
    expect(db.chains[1].update).toHaveBeenCalledWith({
      source: "ai_sms",
      actor: "+15550001111"
    });
  });

  it("skips the label write when there is nothing to attribute", async () => {
    const db = mockDb([{ data: { id: "row-1" }, error: null }]);
    await deleteCustomTableRow("tbl-1", "row-1", undefined, asClient(db));
    expect(db.from).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed label rather than reporting a delete that already happened", async () => {
    const db = mockDb([
      { data: { id: "row-1" }, error: null },
      { data: null, error: { message: "label boom" } }
    ]);
    await expect(
      deleteCustomTableRow("tbl-1", "row-1", { source: "mcp" }, asClient(db))
    ).resolves.toBeUndefined();
  });

  it("reports a vanished row as not_found and throws on failure", async () => {
    await expect(
      deleteCustomTableRow("tbl-1", "row-1", undefined, asClient(mockDb([{ data: null, error: null }])))
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      deleteCustomTableRow("tbl-1", "row-1", undefined, asClient(mockDb([{ data: null, error: { message: "boom" } }])))
    ).rejects.toThrow("deleteCustomTableRow: boom");
  });
});

describe("deleteCustomTableRowsForContact", () => {
  it("deletes the person's rows AND the history snapshots the delete just wrote", async () => {
    const db = mockDb([
      { data: [{ id: "row-1" }, { id: "row-2" }], error: null },
      { data: null, error: null }
    ]);
    expect(await deleteCustomTableRowsForContact("biz-1", "c-1", asClient(db))).toBe(2);
    expect(db.chains[0].eq).toHaveBeenCalledWith("contact_id", "c-1");
    // Without this second delete, erasing a person would COPY their values
    // into custom_table_versions instead of removing them.
    expect(db.chains[1].in).toHaveBeenCalledWith("row_id", ["row-1", "row-2"]);
  });

  it("skips the history delete when the person had no rows", async () => {
    const db = mockDb([{ data: [], error: null }]);
    expect(await deleteCustomTableRowsForContact("biz-1", "c-1", asClient(db))).toBe(0);
    expect(db.from).toHaveBeenCalledTimes(1);
  });

  it("treats a null payload as no rows", async () => {
    const db = mockDb([{ data: null, error: null }]);
    expect(await deleteCustomTableRowsForContact("biz-1", "c-1", asClient(db))).toBe(0);
  });

  it("throws when either delete fails", async () => {
    await expect(
      deleteCustomTableRowsForContact(
        "biz-1",
        "c-1",
        asClient(mockDb([{ data: null, error: { message: "rows" } }]))
      )
    ).rejects.toThrow("deleteCustomTableRowsForContact: rows");
    await expect(
      deleteCustomTableRowsForContact(
        "biz-1",
        "c-1",
        asClient(
          mockDb([
            { data: [{ id: "row-1" }], error: null },
            { data: null, error: { message: "hist" } }
          ])
        )
      )
    ).rejects.toThrow("deleteCustomTableRowsForContact: history: hist");
  });
});

describe("countRowsByTable", () => {
  it("tallies rows per table", async () => {
    const db = mockDb([
      {
        data: [
          { id: "r1", table_id: "tbl-1" },
          { id: "r2", table_id: "tbl-1" },
          { id: "r3", table_id: "tbl-2" }
        ],
        error: null
      }
    ]);
    const counts = await countRowsByTable("biz-1", asClient(db));
    expect(counts.get("tbl-1")).toBe(2);
    expect(counts.get("tbl-2")).toBe(1);
  });

  it("pages until a short page", async () => {
    const fullPage = Array.from({ length: FIELD_SWEEP_PAGE_SIZE }, (_, i) => ({
      id: `r${i}`,
      table_id: "tbl-1"
    }));
    const db = mockDb([
      { data: fullPage, error: null },
      { data: [], error: null }
    ]);
    const counts = await countRowsByTable("biz-1", asClient(db));
    expect(counts.get("tbl-1")).toBe(FIELD_SWEEP_PAGE_SIZE);
    expect(db.chains[1].gt).toHaveBeenCalledWith("id", `r${FIELD_SWEEP_PAGE_SIZE - 1}`);
  });

  it("treats a null payload as none, and throws on failure", async () => {
    expect((await countRowsByTable("biz-1", asClient(mockDb([{ data: null, error: null }])))).size).toBe(0);
    await expect(
      countRowsByTable("biz-1", asClient(mockDb([{ data: null, error: { message: "boom" } }])))
    ).rejects.toThrow("countRowsByTable: boom");
  });
});

describe("CustomTableError", () => {
  it("carries its code and name", () => {
    const err = new CustomTableError("ambiguous", "Which one?");
    expect(err).toMatchObject({ code: "ambiguous", name: "CustomTableError", message: "Which one?" });
    expect(err).toBeInstanceOf(Error);
  });
});
