import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  customTableAddRowTool,
  customTableCreateTool,
  customTableDeleteRowTool,
  customTableDeleteTool,
  customTableFindRowsTool,
  customTableHistoryTool,
  customTableListTool,
  customTableRestoreTool,
  customTableUndoTool,
  customTableUpdateRowTool,
  customTableUpdateSchemaTool,
  type CustomTableToolDeps
} from "@/lib/custom-tables/tool-handlers";
import { CustomTableError } from "@/lib/custom-tables/db";
import type { CustomTable, CustomTableField } from "@/lib/custom-tables/types";

function field(over: Partial<CustomTableField> = {}): CustomTableField {
  return { id: "address", label: "Address", type: "text", required: false, enabled: true, ...over };
}

function table(over: Partial<CustomTable> = {}): CustomTable {
  return {
    id: "tbl-1",
    businessId: "biz-1",
    name: "Properties",
    description: null,
    icon: "home",
    rowLink: "standalone",
    fields: [field()],
    position: 0,
    deletedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...over
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    tableId: "tbl-1",
    contactId: null,
    values: { address: "12 Maple St" },
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...over
  };
}

/** Deps with every core stubbed; each test overrides what it cares about. */
function deps(over: Partial<CustomTableToolDeps> = {}): CustomTableToolDeps {
  return {
    listTables: vi.fn(async () => [table()]) as never,
    listDeleted: vi.fn(async () => []) as never,
    listRows: vi.fn(async () => ({ rows: [row()], nextCursor: null })) as never,
    countRows: vi.fn(async () => 3) as never,
    createTable: vi.fn(async () => table()) as never,
    patchFields: vi.fn(async () => ({ table: table(), sweptRows: 0 })) as never,
    softDelete: vi.fn(async () => undefined) as never,
    restoreTable: vi.fn(async () => table()) as never,
    createRow: vi.fn(async () => row()) as never,
    updateRow: vi.fn(async () => row()) as never,
    deleteRow: vi.fn(async () => undefined) as never,
    listVersions: vi.fn(async () => []) as never,
    restoreVersion: vi.fn(async () => ({ kind: "schema" })) as never,
    lookupContact: vi.fn(async () => ({ id: "c-1" })) as never,
    ...over
  };
}

beforeEach(() => vi.clearAllMocks());

describe("customTableListTool", () => {
  it("hands the model the COLUMN DEFINITIONS, which is what makes a write possible", async () => {
    const rich = table({
      description: "Listings",
      rowLink: "contact",
      fields: [
        field({ id: "status", label: "Status", type: "select", options: ["New", "Won"], required: true }),
        field({ id: "off", label: "Off", enabled: false })
      ]
    });
    const out = await customTableListTool("biz-1", deps({ listTables: vi.fn(async () => [rich]) as never }));
    expect(out).toMatchObject({ ok: true });
    const tables = (out as unknown as { tables: unknown[] }).tables;
    expect(tables[0]).toEqual({
      name: "Properties",
      description: "Listings",
      rowsBelongTo: "one contact each",
      rowCount: 3,
      // A disabled column is not offered, and the choices ride along so the
      // model never invents a status.
      columns: [{ name: "Status", type: "select", choices: ["New", "Won"], required: true }]
    });
  });

  it("says plainly when there are none, and offers the next step", async () => {
    const out = await customTableListTool("biz-1", deps({ listTables: vi.fn(async () => []) as never }));
    expect(out).toMatchObject({ ok: true, tables: [] });
    expect((out as unknown as { note: string }).note).toMatch(/no custom tables yet/i);
  });

  it("describes a standalone table as belonging to nothing in particular", async () => {
    const out = await customTableListTool("biz-1", deps());
    const tables = (out as unknown as { tables: { rowsBelongTo: string }[] }).tables;
    expect(tables[0].rowsBelongTo).toBe("nothing in particular");
  });
});

describe("resolving the table the model named", () => {
  it("lets a READ match on a unique substring", async () => {
    const out = await customTableFindRowsTool("biz-1", { table: "Prop" }, deps());
    expect(out).toMatchObject({ ok: true, table: "Properties" });
  });

  it("refuses a WRITE on a substring, and says writes need the exact name", async () => {
    // A read that lands on the wrong table is visible to the owner. A write
    // that does is not, and a delete is worse still.
    const out = await customTableAddRowTool("biz-1", { table: "Prop", values: [] }, deps());
    expect(out).toMatchObject({ ok: false });
    expect((out as unknown as { message: string }).message).toMatch(/table_not_found.*exact table name/s);
  });

  it("lists the real table names on a miss, so the model asks instead of guessing", async () => {
    const out = await customTableFindRowsTool("biz-1", { table: "Nope" }, deps());
    expect((out as unknown as { message: string }).message).toContain("Properties");
  });

  it("refuses an ambiguous reference and names the candidates", async () => {
    const two = [table({ id: "a", name: "Property notes" }), table({ id: "b", name: "Properties" })];
    const out = await customTableFindRowsTool(
      "biz-1",
      { table: "propert" },
      deps({ listTables: vi.fn(async () => two) as never })
    );
    expect((out as unknown as { message: string }).message).toMatch(/table_ambiguous/);
    expect((out as unknown as { message: string }).message).toContain("Property notes");
  });

  it("says so when the business has no tables at all", async () => {
    const out = await customTableFindRowsTool(
      "biz-1",
      { table: "x" },
      deps({ listTables: vi.fn(async () => []) as never })
    );
    expect((out as unknown as { message: string }).message).toMatch(/no_tables/);
  });
});

describe("every tool that names a table refuses when it cannot find one", () => {
  // The resolve step is the same for all of them, and a tool that skipped it
  // would happily act on whatever came back.
  it.each([
    ["find_rows", () => customTableFindRowsTool("biz-1", { table: "Ghost" }, deps())],
    ["history", () => customTableHistoryTool("biz-1", { table: "Ghost" }, deps())],
    ["add_row", () => customTableAddRowTool("biz-1", { table: "Ghost", values: [] }, deps())],
    [
      "update_row",
      () => customTableUpdateRowTool("biz-1", { table: "Ghost", row: "r", values: [] }, deps())
    ],
    [
      "delete_row",
      () => customTableDeleteRowTool("biz-1", { table: "Ghost", row: "r" }, deps())
    ],
    [
      "update_schema",
      () =>
        customTableUpdateSchemaTool(
          "biz-1",
          { table: "Ghost", action: "add_column", column: "X" },
          deps()
        )
    ],
    ["delete", () => customTableDeleteTool("biz-1", { table: "Ghost" }, deps())]
  ])("%s", async (_label, run) => {
    const out = await run();
    expect((out as unknown as { message: string }).message).toMatch(/table_not_found/);
  });
});

describe("customTableFindRowsTool", () => {
  it("returns each row's id plus a readable summary", async () => {
    const out = await customTableFindRowsTool("biz-1", { table: "Properties" }, deps());
    expect(out).toMatchObject({
      ok: true,
      rows: [{ id: "row-1", summary: "Address: 12 Maple St" }]
    });
  });

  it("filters by the query", async () => {
    const rows = [row(), row({ id: "row-2", values: { address: "9 Oak" } })];
    const out = await customTableFindRowsTool(
      "biz-1",
      { table: "Properties", query: "maple" },
      deps({ listRows: vi.fn(async () => ({ rows, nextCursor: null })) as never })
    );
    expect((out as unknown as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it("caps the rows returned and says how many matched", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ id: `row-${i}` }));
    const out = await customTableFindRowsTool(
      "biz-1",
      { table: "Properties", limit: 2 },
      deps({ listRows: vi.fn(async () => ({ rows, nextCursor: null })) as never })
    );
    expect((out as unknown as { rows: unknown[] }).rows).toHaveLength(2);
    expect((out as unknown as { note: string }).note).toMatch(/Showing 2 of 5/);
  });

  it("tells the model to say nothing matched, rather than guess", async () => {
    const out = await customTableFindRowsTool(
      "biz-1",
      { table: "Properties", query: "birch" },
      deps()
    );
    expect((out as unknown as { note: string }).note).toMatch(/Say so plainly/);
  });

  it("refuses a phone lookup on a table whose rows belong to nobody", async () => {
    const out = await customTableFindRowsTool(
      "biz-1",
      { table: "Properties", contactPhone: "+15550001111" },
      deps()
    );
    expect((out as unknown as { message: string }).message).toMatch(/not_contact_linked/);
  });

  it("actually filters by the contact behind the phone, rather than ignoring it", async () => {
    const linked = table({ rowLink: "contact" });
    const listRows = vi.fn(async () => ({ rows: [row()], nextCursor: null }));
    const out = await customTableFindRowsTool(
      "biz-1",
      { table: "Properties", contactPhone: " +15550001111 " },
      deps({ listTables: vi.fn(async () => [linked]) as never, listRows: listRows as never })
    );
    expect(out).toMatchObject({ ok: true });
    expect(listRows).toHaveBeenCalledWith(
      "tbl-1",
      expect.anything(),
      expect.objectContaining({ contactId: "c-1" })
    );
  });

  it("refuses a phone with no contact behind it, rather than filing under nobody", async () => {
    const linked = table({ rowLink: "contact" });
    const out = await customTableFindRowsTool(
      "biz-1",
      { table: "Properties", contactPhone: "+15559999999" },
      deps({
        listTables: vi.fn(async () => [linked]) as never,
        lookupContact: vi.fn(async () => null) as never
      })
    );
    expect((out as unknown as { message: string }).message).toMatch(/contact_not_found/);
  });
});

describe("customTableAddRowTool", () => {
  it("maps the model's column LABELS onto the stored ids", async () => {
    const createRow = vi.fn(async () => row());
    await customTableAddRowTool(
      "biz-1",
      { table: "Properties", values: [{ field: "Address", value: "12 Maple St" }] },
      deps({ createRow: createRow as never })
    );
    expect(createRow).toHaveBeenCalledWith(
      "biz-1",
      expect.anything(),
      { values: { address: "12 Maple St" }, contactId: null },
      { source: "ai" }
    );
  });

  it("refuses an unknown column and names the real ones, never dropping it", async () => {
    // Silently dropping is how an AI reports saving data that is not there.
    const out = await customTableAddRowTool(
      "biz-1",
      { table: "Properties", values: [{ field: "Colour", value: "red" }] },
      deps()
    );
    expect((out as unknown as { message: string }).message).toMatch(/unknown_column/);
    expect((out as unknown as { message: string }).message).toContain("Address");
  });

  it("relays a bad value in plain English, naming the choices", async () => {
    const withSelect = table({
      fields: [field({ id: "status", label: "Status", type: "select", options: ["New", "Won"] })]
    });
    const out = await customTableAddRowTool(
      "biz-1",
      { table: "Properties", values: [{ field: "Status", value: "Maybe" }] },
      deps({ listTables: vi.fn(async () => [withSelect]) as never })
    );
    expect((out as unknown as { message: string }).message).toMatch(/Status must be one of: New, Won/);
  });

  it("converts a text value to the column's kind", async () => {
    const numeric = table({ fields: [field({ id: "price", label: "Price", type: "number" })] });
    const createRow = vi.fn(async () => row());
    await customTableAddRowTool(
      "biz-1",
      { table: "Properties", values: [{ field: "Price", value: "$1,240" }] },
      deps({ listTables: vi.fn(async () => [numeric]) as never, createRow: createRow as never })
    );
    expect(createRow).toHaveBeenCalledWith(
      "biz-1",
      expect.anything(),
      { values: { price: 1240 }, contactId: null },
      expect.anything()
    );
  });

  it("refuses a row that leaves a required column empty", async () => {
    const strict = table({ fields: [field({ required: true }), field({ id: "city", label: "City" })] });
    const out = await customTableAddRowTool(
      "biz-1",
      { table: "Properties", values: [{ field: "City", value: "Phoenix" }] },
      deps({ listTables: vi.fn(async () => [strict]) as never })
    );
    expect((out as unknown as { message: string }).message).toMatch(/bad_value.*Address is required/s);
  });

  it("refuses a phone on a standalone table", async () => {
    const out = await customTableAddRowTool(
      "biz-1",
      { table: "Properties", values: [], contactPhone: "+15550001111" },
      deps()
    );
    expect((out as unknown as { message: string }).message).toMatch(/not_contact_linked/);
  });

  it("attaches the row to the contact behind the phone", async () => {
    const linked = table({ rowLink: "contact" });
    const createRow = vi.fn(async () => row());
    const out = await customTableAddRowTool(
      "biz-1",
      { table: "Properties", values: [], contactPhone: "+15550001111" },
      deps({ listTables: vi.fn(async () => [linked]) as never, createRow: createRow as never })
    );
    expect(out).toMatchObject({ ok: true });
    expect(createRow).toHaveBeenCalledWith(
      "biz-1",
      expect.anything(),
      { values: {}, contactId: "c-1" },
      expect.anything()
    );
  });

  it("refuses a phone with no contact behind it", async () => {
    const linked = table({ rowLink: "contact" });
    const out = await customTableAddRowTool(
      "biz-1",
      { table: "Properties", values: [], contactPhone: "+15559999999" },
      deps({
        listTables: vi.fn(async () => [linked]) as never,
        lookupContact: vi.fn(async () => null) as never
      })
    );
    expect((out as unknown as { message: string }).message).toMatch(/contact_not_found/);
  });

  it("tells the owner the row is not attached to anyone when no phone was given", async () => {
    const linked = table({ rowLink: "contact" });
    const out = await customTableAddRowTool(
      "biz-1",
      { table: "Properties", values: [] },
      deps({ listTables: vi.fn(async () => [linked]) as never })
    );
    expect((out as unknown as { note: string }).note).toMatch(/not attached to a contact yet/);
  });

  it("relays the row cap rather than throwing", async () => {
    const out = await customTableAddRowTool(
      "biz-1",
      { table: "Properties", values: [] },
      deps({
        createRow: vi.fn(async () => {
          throw new CustomTableError("limit", "full up");
        }) as never
      })
    );
    expect(out).toEqual({ ok: false, message: "full up" });
  });

  it("lets an unexpected failure through, rather than reporting it as a refusal", async () => {
    await expect(
      customTableAddRowTool(
        "biz-1",
        { table: "Properties", values: [] },
        deps({
          createRow: vi.fn(async () => {
            throw new Error("db down");
          }) as never
        })
      )
    ).rejects.toThrow("db down");
  });

  it("wraps a non-Error throw so the caller still sees a real Error", async () => {
    await expect(
      customTableAddRowTool(
        "biz-1",
        { table: "Properties", values: [] },
        deps({
          createRow: vi.fn(async () => {
            throw "not an error";
          }) as never
        })
      )
    ).rejects.toThrow("customTableAddRowTool failed");
  });
});

describe("customTableUpdateRowTool", () => {
  it("changes the named cells and passes the blanked ones as cleared", async () => {
    const two = table({
      fields: [field(), field({ id: "city", label: "City" })]
    });
    const updateRow = vi.fn(async () => row());
    await customTableUpdateRowTool(
      "biz-1",
      {
        table: "Properties",
        row: "row-1",
        values: [
          { field: "Address", value: "14 Oak Ave" },
          { field: "City", value: "" }
        ]
      },
      deps({ listTables: vi.fn(async () => [two]) as never, updateRow: updateRow as never })
    );
    expect(updateRow).toHaveBeenCalledWith(
      expect.anything(),
      "row-1",
      { values: { address: "14 Oak Ave" }, clear: ["city"] },
      { source: "ai" }
    );
  });

  it.each([
    ["number", "price", "Price", "number" as const],
    ["date", "renews", "Renews", "date" as const],
    ["choice", "status", "Status", "select" as const]
  ])("can clear a %s cell, not just a text one", async (_label, id, label, type) => {
    // Coercion runs on a real value, so running it BEFORE the empty check
    // meant "" failed for every kind except text, and the coworker could
    // never empty a price or a date.
    const t = table({
      fields: [
        field({ id, label, type, ...(type === "select" ? { options: ["New", "Won"] } : {}) })
      ]
    });
    const updateRow = vi.fn(async () => row());
    const out = await customTableUpdateRowTool(
      "biz-1",
      { table: "Properties", row: "row-1", values: [{ field: label, value: "" }] },
      deps({ listTables: vi.fn(async () => [t]) as never, updateRow: updateRow as never })
    );
    expect(out).toMatchObject({ ok: true });
    expect(updateRow).toHaveBeenCalledWith(
      expect.anything(),
      "row-1",
      { values: {}, clear: [id] },
      expect.anything()
    );
  });

  it("changes one cell on a table that has a required column", async () => {
    // A required column the model did not mention is one nobody is
    // touching. Without partial mode, marking any column required would
    // make every other cell uneditable by the coworker.
    const t = table({
      fields: [field({ required: true }), field({ id: "city", label: "City" })]
    });
    const out = await customTableUpdateRowTool(
      "biz-1",
      { table: "Properties", row: "row-1", values: [{ field: "City", value: "Tempe" }] },
      deps({ listTables: vi.fn(async () => [t]) as never })
    );
    expect(out).toMatchObject({ ok: true });
  });

  it("refuses when no row matches, pointing at the find tool", async () => {
    const out = await customTableUpdateRowTool(
      "biz-1",
      { table: "Properties", row: "birch", values: [] },
      deps()
    );
    expect((out as unknown as { message: string }).message).toMatch(/row_not_found.*Find it first/s);
  });

  it("refuses an ambiguous row rather than picking one", async () => {
    const rows = [row(), row({ id: "row-2" })];
    const out = await customTableUpdateRowTool(
      "biz-1",
      { table: "Properties", row: "maple", values: [] },
      deps({ listRows: vi.fn(async () => ({ rows, nextCursor: null })) as never })
    );
    expect((out as unknown as { message: string }).message).toMatch(/row_ambiguous/);
  });

  it("relays a bad column, and a typed db failure", async () => {
    expect(
      (
        (await customTableUpdateRowTool(
          "biz-1",
          { table: "Properties", row: "row-1", values: [{ field: "Ghost", value: "x" }] },
          deps()
        )) as unknown as { message: string }
      ).message
    ).toMatch(/unknown_column/);
    expect(
      await customTableUpdateRowTool(
        "biz-1",
        { table: "Properties", row: "row-1", values: [] },
        deps({
          updateRow: vi.fn(async () => {
            throw new CustomTableError("not_found", "gone");
          }) as never
        })
      )
    ).toEqual({ ok: false, message: "gone" });
  });
});

describe("customTableDeleteRowTool", () => {
  it("refuses without confirm, and reads the row back so the owner hears it", async () => {
    const deleteRow = vi.fn(async () => undefined);
    const out = await customTableDeleteRowTool(
      "biz-1",
      { table: "Properties", row: "row-1" },
      deps({ deleteRow: deleteRow as never })
    );
    expect((out as unknown as { message: string }).message).toMatch(/needs_confirmation/);
    expect((out as unknown as { message: string }).message).toContain("Address: 12 Maple St");
    expect(deleteRow).not.toHaveBeenCalled();
  });

  it("says (empty) rather than nothing at all for a blank row", async () => {
    const out = await customTableDeleteRowTool(
      "biz-1",
      { table: "Properties", row: "row-1" },
      deps({ listRows: vi.fn(async () => ({ rows: [row({ values: {} })], nextCursor: null })) as never })
    );
    expect((out as unknown as { message: string }).message).toContain("(empty)");
  });

  it("deletes on the second call and tells the owner it can come back", async () => {
    const deleteRow = vi.fn(async () => undefined);
    const out = await customTableDeleteRowTool(
      "biz-1",
      { table: "Properties", row: "row-1", confirm: true },
      deps({ deleteRow: deleteRow as never })
    );
    expect(deleteRow).toHaveBeenCalledWith("tbl-1", "row-1", { source: "ai" });
    expect((out as unknown as { note: string }).note).toMatch(/put back from Recent changes/);
  });

  it("never guesses which row to delete", async () => {
    const rows = [row(), row({ id: "row-2" })];
    const out = await customTableDeleteRowTool(
      "biz-1",
      { table: "Properties", row: "maple", confirm: true },
      deps({ listRows: vi.fn(async () => ({ rows, nextCursor: null })) as never })
    );
    expect((out as unknown as { message: string }).message).toMatch(/row_ambiguous.*Never guess/s);
  });

  it("refuses a row that is gone, and relays a typed failure", async () => {
    expect(
      (
        (await customTableDeleteRowTool(
          "biz-1",
          { table: "Properties", row: "birch", confirm: true },
          deps()
        )) as unknown as { message: string }
      ).message
    ).toMatch(/row_not_found/);
    expect(
      await customTableDeleteRowTool(
        "biz-1",
        { table: "Properties", row: "row-1", confirm: true },
        deps({
          deleteRow: vi.fn(async () => {
            throw new CustomTableError("not_found", "already gone");
          }) as never
        })
      )
    ).toEqual({ ok: false, message: "already gone" });
  });
});

describe("customTableHistoryTool and undo", () => {
  it("returns the changes in plain English with undo ids", async () => {
    const versions = [
      {
        id: 7,
        tableId: "tbl-1",
        rowId: null,
        kind: "schema" as const,
        name: "Old name",
        description: null,
        rowLink: "standalone",
        fields: [field()],
        values: null,
        contactId: null,
        source: "ai_dashboard",
        actor: null,
        replacedAt: "2026-08-20T00:00:00.000Z"
      }
    ];
    const out = await customTableHistoryTool(
      "biz-1",
      { table: "Properties" },
      deps({ listVersions: vi.fn(async () => versions) as never })
    );
    expect(out).toMatchObject({ ok: true, table: "Properties" });
    const changes = (out as unknown as { changes: { id: number; changed: string[]; canUndo: boolean }[] }).changes;
    expect(changes[0]).toMatchObject({ id: 7, canUndo: true });
    expect(changes[0].changed).toEqual(['Renamed the table to "Properties"']);
  });

  it("says plainly when nothing has changed", async () => {
    const out = await customTableHistoryTool("biz-1", { table: "Properties" }, deps());
    expect((out as unknown as { note: string }).note).toMatch(/Nothing has changed/);
  });

  it("undoes a change, and names what came back", async () => {
    const restoreVersion = vi.fn(async () => ({ kind: "row_recreated", rowId: "row-9" }));
    const out = await customTableUndoTool(
      "biz-1",
      { changeId: 7 },
      deps({ restoreVersion: restoreVersion as never })
    );
    expect(restoreVersion).toHaveBeenCalledWith("biz-1", 7, { source: "ai_restore" });
    expect((out as unknown as { note: string }).note).toMatch(/new id/);
  });

  it("uses the plain note for every other kind of undo", async () => {
    const out = await customTableUndoTool("biz-1", { changeId: 7 }, deps());
    expect((out as unknown as { note: string }).note).toMatch(/Put back/);
  });

  it("relays a pruned change rather than throwing", async () => {
    const out = await customTableUndoTool(
      "biz-1",
      { changeId: 7 },
      deps({
        restoreVersion: vi.fn(async () => {
          throw new CustomTableError("not_found", "no longer in the history");
        }) as never
      })
    );
    expect(out).toEqual({ ok: false, message: "no longer in the history" });
  });
});

describe("customTableCreateTool", () => {
  it("generates the column ids and defaults the kind to text", async () => {
    const createTable = vi.fn(async () => table());
    await customTableCreateTool(
      "biz-1",
      { name: "Vehicles", columns: [{ label: "Make and model" }] },
      deps({ createTable: createTable as never })
    );
    expect(createTable).toHaveBeenCalledWith("biz-1", {
      name: "Vehicles",
      description: null,
      rowLink: "standalone",
      fields: [
        {
          id: "make_and_model",
          label: "Make and model",
          type: "text",
          required: false,
          enabled: true
        }
      ]
    });
  });

  it("links rows to contacts only when asked", async () => {
    const createTable = vi.fn(async () => table());
    await customTableCreateTool(
      "biz-1",
      { name: "Policies", linkToContacts: true, description: "Book of business", columns: [{ label: "Plan" }] },
      deps({ createTable: createTable as never })
    );
    expect(createTable).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ rowLink: "contact", description: "Book of business" })
    );
  });

  it("refuses a choice column with fewer than two choices, and says what to ask", async () => {
    const out = await customTableCreateTool(
      "biz-1",
      { name: "Jobs", columns: [{ label: "Status", type: "select", options: ["Only"] }] },
      deps()
    );
    expect((out as unknown as { message: string }).message).toMatch(/bad_column.*at least two choices/s);
  });

  it("keeps the choices on a well-formed choice column", async () => {
    const createTable = vi.fn(async () => table());
    await customTableCreateTool(
      "biz-1",
      { name: "Jobs", columns: [{ label: "Status", type: "select", options: [" New ", "Won"] }] },
      deps({ createTable: createTable as never })
    );
    expect(createTable).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({
        fields: [expect.objectContaining({ options: ["New", "Won"] })]
      })
    );
  });

  it("uniquifies ids when two columns slugify the same", async () => {
    const createTable = vi.fn(async () => table());
    await customTableCreateTool(
      "biz-1",
      { name: "Jobs", columns: [{ label: "Start date" }, { label: "Start  date" }] },
      deps({ createTable: createTable as never })
    );
    expect(createTable).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({
        fields: [
          expect.objectContaining({ id: "start_date" }),
          expect.objectContaining({ id: "start_date_2" })
        ]
      })
    );
  });

  it("relays a duplicate name rather than throwing", async () => {
    const out = await customTableCreateTool(
      "biz-1",
      { name: "Properties", columns: [{ label: "Name" }] },
      deps({
        createTable: vi.fn(async () => {
          throw new CustomTableError("duplicate", "already have one");
        }) as never
      })
    );
    expect(out).toEqual({ ok: false, message: "already have one" });
  });
});

describe("customTableUpdateSchemaTool", () => {
  it("adds a column", async () => {
    const patchFields = vi.fn(async () => ({ table: table(), sweptRows: 0 }));
    await customTableUpdateSchemaTool(
      "biz-1",
      { table: "Properties", action: "add_column", column: "Price", type: "number" },
      deps({ patchFields: patchFields as never })
    );
    expect(patchFields).toHaveBeenCalledWith(
      "biz-1",
      "tbl-1",
      { action: "add", label: "Price", type: "number" },
      { source: "ai" }
    );
  });

  it("adds a plain column without dragging an empty options list along", async () => {
    const patchFields = vi.fn(
      async (_b: string, _t: string, _p: unknown, _e?: unknown) => ({
        table: table(),
        sweptRows: 0
      })
    );
    await customTableUpdateSchemaTool(
      "biz-1",
      { table: "Properties", action: "add_column", column: "Notes" },
      deps({ patchFields: patchFields as never })
    );
    expect(patchFields.mock.calls[0][2]).toEqual({
      action: "add",
      label: "Notes",
      type: "text"
    });
  });

  it("keeps the choices when adding a choice column", async () => {
    const patchFields = vi.fn(
      async (_b: string, _t: string, _p: unknown, _e?: unknown) => ({
        table: table(),
        sweptRows: 0
      })
    );
    await customTableUpdateSchemaTool(
      "biz-1",
      {
        table: "Properties",
        action: "add_column",
        column: "Status",
        type: "select",
        options: [" New ", "Won"]
      },
      deps({ patchFields: patchFields as never })
    );
    expect(patchFields.mock.calls[0][2]).toMatchObject({ options: ["New", "Won"] });
  });

  it("refuses to add a choice column with one choice", async () => {
    const out = await customTableUpdateSchemaTool(
      "biz-1",
      { table: "Properties", action: "add_column", column: "Status", type: "select", options: ["Only"] },
      deps()
    );
    expect((out as unknown as { message: string }).message).toMatch(/at least two choices/);
  });

  it("renames a column, and says nothing written in it changed", async () => {
    const patchFields = vi.fn(async () => ({ table: table(), sweptRows: 0 }));
    const out = await customTableUpdateSchemaTool(
      "biz-1",
      { table: "Properties", action: "rename_column", column: "Address", newName: "Street" },
      deps({ patchFields: patchFields as never })
    );
    expect(patchFields).toHaveBeenCalledWith(
      "biz-1",
      "tbl-1",
      { action: "update", fieldId: "address", label: "Street" },
      { source: "ai" }
    );
    expect((out as unknown as { note: string }).note).toMatch(/Nothing written in it changed/);
  });

  it("refuses a rename with no new name", async () => {
    const out = await customTableUpdateSchemaTool(
      "biz-1",
      { table: "Properties", action: "rename_column", column: "Address" },
      deps()
    );
    expect((out as unknown as { message: string }).message).toMatch(/missing_new_name/);
  });

  it("refuses a column the table does not have, naming the real ones", async () => {
    const out = await customTableUpdateSchemaTool(
      "biz-1",
      { table: "Properties", action: "rename_column", column: "Ghost", newName: "X" },
      deps()
    );
    expect((out as unknown as { message: string }).message).toMatch(/unknown_column/);
    expect((out as unknown as { message: string }).message).toContain("Address");
  });

  it("warns before deleting a column, because no per-row undo covers it", async () => {
    const patchFields = vi.fn(async () => ({ table: table(), sweptRows: 0 }));
    const out = await customTableUpdateSchemaTool(
      "biz-1",
      { table: "Properties", action: "delete_column", column: "Address" },
      deps({ patchFields: patchFields as never })
    );
    expect((out as unknown as { message: string }).message).toMatch(/needs_confirmation.*every row/s);
    expect(patchFields).not.toHaveBeenCalled();
  });

  it("deletes the column on the second call and reports the sweep", async () => {
    const out = await customTableUpdateSchemaTool(
      "biz-1",
      { table: "Properties", action: "delete_column", column: "Address", confirm: true },
      deps({ patchFields: vi.fn(async () => ({ table: table(), sweptRows: 12 })) as never })
    );
    expect((out as unknown as { note: string }).note).toMatch(/cleared it from 12 row/);
  });

  it("relays typed failures from every branch", async () => {
    const boom = vi.fn(async () => {
      throw new CustomTableError("invalid", "no");
    });
    for (const args of [
      { table: "Properties", action: "add_column" as const, column: "X" },
      { table: "Properties", action: "rename_column" as const, column: "Address", newName: "Y" },
      { table: "Properties", action: "delete_column" as const, column: "Address", confirm: true }
    ]) {
      expect(
        await customTableUpdateSchemaTool("biz-1", args, deps({ patchFields: boom as never }))
      ).toEqual({ ok: false, message: "no" });
    }
  });
});

describe("customTableDeleteTool", () => {
  it("tells the owner how many rows it holds before deleting anything", async () => {
    const softDelete = vi.fn(async () => undefined);
    const out = await customTableDeleteTool(
      "biz-1",
      { table: "Properties" },
      deps({ softDelete: softDelete as never, countRows: vi.fn(async () => 42) as never })
    );
    expect((out as unknown as { message: string }).message).toMatch(/needs_confirmation.*42 row/s);
    expect(softDelete).not.toHaveBeenCalled();
  });

  it("deletes on the second call and says it can be brought back", async () => {
    const softDelete = vi.fn(async () => undefined);
    const out = await customTableDeleteTool(
      "biz-1",
      { table: "Properties", confirm: true },
      deps({ softDelete: softDelete as never })
    );
    expect(softDelete).toHaveBeenCalledWith("biz-1", "tbl-1", null, { source: "ai" });
    expect((out as unknown as { note: string }).note).toMatch(/brought back for 30 days/);
  });

  it("relays a typed failure", async () => {
    const out = await customTableDeleteTool(
      "biz-1",
      { table: "Properties", confirm: true },
      deps({
        softDelete: vi.fn(async () => {
          throw new CustomTableError("not_found", "gone");
        }) as never
      })
    );
    expect(out).toEqual({ ok: false, message: "gone" });
  });
});

describe("customTableRestoreTool", () => {
  it("brings a deleted table back", async () => {
    const restoreTable = vi.fn(async () => table());
    const out = await customTableRestoreTool(
      "biz-1",
      { table: "Properties" },
      deps({
        listDeleted: vi.fn(async () => [table({ deletedAt: "2026-08-20" })]) as never,
        restoreTable: restoreTable as never
      })
    );
    expect(restoreTable).toHaveBeenCalledWith("biz-1", "tbl-1", { source: "ai_restore" });
    expect((out as unknown as { note: string }).note).toMatch(/is back, with everything/);
  });

  it("says so when the trash is empty", async () => {
    const out = await customTableRestoreTool("biz-1", { table: "Properties" }, deps());
    expect((out as unknown as { message: string }).message).toMatch(/nothing_deleted/);
  });

  it("names the deleted tables on a miss and on an ambiguity", async () => {
    const miss = await customTableRestoreTool(
      "biz-1",
      { table: "Vehicles" },
      deps({ listDeleted: vi.fn(async () => [table({ deletedAt: "x" })]) as never })
    );
    expect((miss as unknown as { message: string }).message).toMatch(/table_not_found/);
    expect((miss as unknown as { message: string }).message).toContain("Properties");

    const dupes = [
      table({ id: "a", name: "Property notes", deletedAt: "x" }),
      table({ id: "b", name: "Properties", deletedAt: "x" })
    ];
    const ambiguous = await customTableRestoreTool(
      "biz-1",
      { table: "propert" },
      deps({ listDeleted: vi.fn(async () => dupes) as never })
    );
    expect((ambiguous as unknown as { message: string }).message).toMatch(/table_ambiguous/);
  });

  it("relays a typed failure", async () => {
    const out = await customTableRestoreTool(
      "biz-1",
      { table: "Properties" },
      deps({
        listDeleted: vi.fn(async () => [table({ deletedAt: "x" })]) as never,
        restoreTable: vi.fn(async () => {
          throw new CustomTableError("duplicate", "name taken");
        }) as never
      })
    );
    expect(out).toEqual({ ok: false, message: "name taken" });
  });
});
