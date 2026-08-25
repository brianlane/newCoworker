import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async (_auth, explicit?: string) => explicit ?? "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});

vi.mock("@/lib/custom-tables/tool-handlers", () => ({
  customTableListTool: vi.fn(async () => ({ ok: true, tables: [] })),
  customTableFindRowsTool: vi.fn(async () => ({ ok: true, rows: [] })),
  customTableAddRowTool: vi.fn(async () => ({ ok: true, rowId: "row-1" })),
  customTableUpdateRowTool: vi.fn(async () => ({ ok: true, rowId: "row-1" })),
  customTableDeleteRowTool: vi.fn(async () => ({ ok: false, message: "needs_confirmation: ..." })),
  customTableCreateTool: vi.fn(async () => ({ ok: true, table: "Vehicles" })),
  customTableDeleteTool: vi.fn(async () => ({ ok: false, message: "needs_confirmation: ..." })),
  customTableRestoreTool: vi.fn(async () => ({ ok: true, table: "Properties" }))
}));

import { requireMcpBusinessRole } from "@/lib/mcp/auth";
import {
  createCustomTableRowTool,
  createCustomTableTool,
  customTableTools,
  deleteCustomTableRowTool,
  deleteCustomTableTool,
  getCustomTableRowsTool,
  listCustomTablesTool,
  restoreCustomTableTool,
  updateCustomTableRowTool
} from "@/lib/mcp/tools/custom-tables";
import {
  customTableAddRowTool,
  customTableCreateTool,
  customTableDeleteRowTool,
  customTableDeleteTool,
  customTableFindRowsTool,
  customTableListTool,
  customTableRestoreTool,
  customTableUpdateRowTool
} from "@/lib/custom-tables/tool-handlers";
import { runTool } from "./helpers/run-mcp-tool";

const AUTH = { userId: "user-1", email: "owner@biz.com" };

beforeEach(() => vi.clearAllMocks());

describe("the role bar each tool enforces", () => {
  // Mirrors the dashboard routes exactly: reading and filling in a table is
  // data entry, BUILDING or deleting one is schema work. A refactor that
  // moved either would be a privilege change, so it is pinned here.
  it.each([
    [listCustomTablesTool, { }, "view_dashboard"],
    [getCustomTableRowsTool, { table: "Properties" }, "view_dashboard"],
    [createCustomTableRowTool, { table: "Properties", values: [] }, "operate_messages"],
    [
      updateCustomTableRowTool,
      { table: "Properties", row: "row-1", values: [] },
      "operate_messages"
    ],
    [deleteCustomTableRowTool, { table: "Properties", row: "row-1" }, "operate_messages"],
    [createCustomTableTool, { name: "V", columns: [{ label: "Name" }] }, "manage_settings"],
    [deleteCustomTableTool, { table: "Properties" }, "manage_settings"],
    [restoreCustomTableTool, { table: "Properties" }, "manage_settings"]
  ])("%#", async (tool, args, bar) => {
    await runTool(tool, args as Record<string, unknown>, AUTH);
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", bar);
  });
});

describe("every tool hands off to the shared core", () => {
  it("lists tables", async () => {
    await runTool(listCustomTablesTool, {}, AUTH);
    expect(customTableListTool).toHaveBeenCalledWith("biz-1", { edit: { source: "mcp" } });
  });

  it("reads rows, passing the optional filters only when supplied", async () => {
    await runTool(getCustomTableRowsTool, { table: "Properties" }, AUTH);
    expect(customTableFindRowsTool).toHaveBeenCalledWith(
      "biz-1",
      { table: "Properties" },
      { edit: { source: "mcp" } }
    );

    vi.mocked(customTableFindRowsTool).mockClear();
    await runTool(
      getCustomTableRowsTool,
      { table: "Properties", query: "maple", contact_phone: "+15550001111", limit: 5 },
      AUTH
    );
    expect(customTableFindRowsTool).toHaveBeenCalledWith(
      "biz-1",
      { table: "Properties", query: "maple", contactPhone: "+15550001111", limit: 5 },
      expect.anything()
    );
  });

  it("adds a row, renaming contact_phone to what the core expects", async () => {
    await runTool(
      createCustomTableRowTool,
      { table: "Properties", values: [{ field: "Address", value: "12 Maple St" }] },
      AUTH
    );
    expect(customTableAddRowTool).toHaveBeenCalledWith(
      "biz-1",
      { table: "Properties", values: [{ field: "Address", value: "12 Maple St" }] },
      { edit: { source: "mcp" } }
    );

    vi.mocked(customTableAddRowTool).mockClear();
    await runTool(
      createCustomTableRowTool,
      { table: "Properties", values: [], contact_phone: "+15550001111" },
      AUTH
    );
    expect(customTableAddRowTool).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ contactPhone: "+15550001111" }),
      expect.anything()
    );
  });

  it("changes a row", async () => {
    await runTool(
      updateCustomTableRowTool,
      { table: "Properties", row: "row-1", values: [{ field: "Address", value: "" }] },
      AUTH
    );
    expect(customTableUpdateRowTool).toHaveBeenCalledWith(
      "biz-1",
      { table: "Properties", row: "row-1", values: [{ field: "Address", value: "" }] },
      { edit: { source: "mcp" } }
    );
  });

  it("passes confirm through only when it is true, so the first call always refuses", async () => {
    await runTool(deleteCustomTableRowTool, { table: "Properties", row: "row-1" }, AUTH);
    expect(customTableDeleteRowTool).toHaveBeenCalledWith(
      "biz-1",
      { table: "Properties", row: "row-1" },
      expect.anything()
    );

    vi.mocked(customTableDeleteRowTool).mockClear();
    await runTool(
      deleteCustomTableRowTool,
      { table: "Properties", row: "row-1", confirm: true },
      AUTH
    );
    expect(customTableDeleteRowTool).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ confirm: true }),
      expect.anything()
    );

    // false must not become confirm:true by arriving at all.
    vi.mocked(customTableDeleteRowTool).mockClear();
    await runTool(
      deleteCustomTableRowTool,
      { table: "Properties", row: "row-1", confirm: false },
      AUTH
    );
    expect(customTableDeleteRowTool).toHaveBeenCalledWith(
      "biz-1",
      { table: "Properties", row: "row-1" },
      expect.anything()
    );
  });

  it("builds a table, passing the optional parts only when supplied", async () => {
    await runTool(createCustomTableTool, { name: "Vehicles", columns: [{ label: "Name" }] }, AUTH);
    expect(customTableCreateTool).toHaveBeenCalledWith(
      "biz-1",
      { name: "Vehicles", columns: [{ label: "Name" }] },
      { edit: { source: "mcp" } }
    );

    vi.mocked(customTableCreateTool).mockClear();
    await runTool(
      createCustomTableTool,
      {
        name: "Policies",
        description: "Book of business",
        link_to_contacts: true,
        columns: [{ label: "Plan", type: "select", options: ["Gold", "Silver"] }]
      },
      AUTH
    );
    expect(customTableCreateTool).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ description: "Book of business", linkToContacts: true }),
      expect.anything()
    );
  });

  it("deletes a table behind the same confirm handshake", async () => {
    await runTool(deleteCustomTableTool, { table: "Properties" }, AUTH);
    expect(customTableDeleteTool).toHaveBeenCalledWith(
      "biz-1",
      { table: "Properties" },
      expect.anything()
    );

    vi.mocked(customTableDeleteTool).mockClear();
    await runTool(deleteCustomTableTool, { table: "Properties", confirm: true }, AUTH);
    expect(customTableDeleteTool).toHaveBeenCalledWith(
      "biz-1",
      { table: "Properties", confirm: true },
      expect.anything()
    );
  });

  it("hands the core the SURFACE, which appends the restore suffix itself", async () => {
    // Passing "mcp_restore" here would file the undo as
    // "mcp_restore_restore", since the core derives the suffix.
    await runTool(restoreCustomTableTool, { table: "Properties" }, AUTH);
    expect(customTableRestoreTool).toHaveBeenCalledWith(
      "biz-1",
      { table: "Properties" },
      { edit: { source: "mcp" } }
    );
  });

  it("honours an explicit business_id over the account default", async () => {
    await runTool(listCustomTablesTool, { business_id: "biz-2" }, AUTH);
    expect(customTableListTool).toHaveBeenCalledWith("biz-2", expect.anything());
  });
});

describe("the exported set", () => {
  it("carries every tool exactly once", () => {
    const names = customTableTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      "list_custom_tables",
      "get_custom_table_rows",
      "create_custom_table_row",
      "update_custom_table_row",
      "delete_custom_table_row",
      "create_custom_table",
      "delete_custom_table",
      "restore_custom_table"
    ]);
  });
});

describe("what the parameter descriptions steer the model toward", () => {
  // list_custom_tables returns LIVE tables only, so a deleted one is
  // structurally absent from it. Pointing restore at that list would have the
  // model tell the owner the table is gone instead of bringing it back.
  it("does not send restore to a list that cannot contain a deleted table", () => {
    const described = (restoreCustomTableTool.schema.table as { description?: string })
      .description;
    expect(described).toBeTruthy();
    expect(described).not.toMatch(/list_custom_tables gave it/);
    expect(described).toMatch(/DELETED/);
  });

  it("still points the read and write tools at the live list", () => {
    for (const tool of [getCustomTableRowsTool, updateCustomTableRowTool]) {
      const described = (tool.schema.table as { description?: string }).description;
      expect(described).toMatch(/list_custom_tables/);
    }
  });
});
