/**
 * Custom-table tools for the connector surfaces (the Claude connector and
 * the ChatGPT app).
 *
 * These are the owner's own tables from /dashboard/tables: they define the
 * columns, so nothing here can assume what a row means. Every handler runs
 * as the authed caller through requireMcpBusinessRole, at the same bars the
 * dashboard routes enforce: reading and filling in a table is data entry
 * (view_dashboard / operate_messages), while BUILDING or deleting one is
 * schema work (manage_settings).
 *
 * These names are verb-first (`create_custom_table_row`) rather than the
 * inline path's `custom_table_add_row`, which is the MCP convention. Both
 * call the SAME shared cores in src/lib/custom-tables/, so a connector and
 * dashboard chat resolve tables, refuse, and steer identically. Because they
 * duplicate the inline tools' capability, all eight are deliberately EXCLUDED
 * from the inline bridge (src/lib/dashboard-chat/mcp-bridge.ts): one tool per
 * capability per surface, so the model is never handed two ways to do the
 * same thing.
 *
 * The read/write asymmetry from the shared cores applies here too: a read may
 * name a table by a unique substring, a write needs the exact name or the id.
 */

import { z } from "zod";
import { requireMcpBusinessRole, resolveMcpBusinessId } from "@/lib/mcp/auth";
import { defineMcpTool, TOOL_BEHAVIOR } from "@/lib/mcp/tooling";

const businessIdField = z
  .string()
  .uuid()
  .optional()
  .describe(
    "Business to operate on. Optional when the account has exactly one business; otherwise call list_businesses first."
  );

const tableField = z
  .string()
  .min(1)
  .max(200)
  .describe("Table name as list_custom_tables gave it.");

const valuePairsField = z
  .array(
    z.object({
      field: z.string().min(1).max(80).describe("Column name, exactly as listed."),
      value: z.string().max(4000).describe("The value as text. Empty text clears the cell.")
    })
  )
  .max(20)
  .describe("Cells to set, each pairing a column name with its value as text.");

/** Every tool answers this envelope, so a refusal is data rather than a throw. */
const resultShape = z.looseObject({ ok: z.boolean() });

export const listCustomTablesTool = defineMcpTool({
  name: "list_custom_tables",
  title: "List custom tables",
  annotations: TOOL_BEHAVIOR.readLocal,
  outputSchema: resultShape,
  description:
    "List the tables this business built for itself, with each table's columns, the kind of value each column holds, its choices when it is a choice column, and how many rows it has. Call this before any other custom-table tool so you use real table and column names.",
  schema: { business_id: businessIdField },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "view_dashboard");
    const { customTableListTool } = await import("@/lib/custom-tables/tool-handlers");
    return await customTableListTool(businessId, { edit: { source: "mcp" } });
  }
});

export const getCustomTableRowsTool = defineMcpTool({
  name: "get_custom_table_rows",
  title: "Read custom table rows",
  annotations: TOOL_BEHAVIOR.readLocal,
  outputSchema: resultShape,
  description:
    "Read rows from one of the business's own tables. Optionally filter with free text matched against every cell, or by the phone number of the contact a row belongs to. Returns each row's id plus a one-line summary; the id is what you pass when changing or deleting that row.",
  schema: {
    business_id: businessIdField,
    table: tableField,
    query: z.string().max(200).optional().describe("Optional text to match against the rows."),
    contact_phone: z
      .string()
      .max(32)
      .optional()
      .describe("Optional. Only for a table whose rows each belong to a contact."),
    limit: z.number().int().min(1).max(25).optional().describe("Optional cap, at most 25.")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "view_dashboard");
    const { customTableFindRowsTool } = await import("@/lib/custom-tables/tool-handlers");
    return await customTableFindRowsTool(
      businessId,
      {
        table: args.table,
        ...(args.query ? { query: args.query } : {}),
        ...(args.contact_phone ? { contactPhone: args.contact_phone } : {}),
        ...(args.limit ? { limit: args.limit } : {})
      },
      { edit: { source: "mcp" } }
    );
  }
});

export const createCustomTableRowTool = defineMcpTool({
  name: "create_custom_table_row",
  title: "Add a custom table row",
  annotations: TOOL_BEHAVIOR.writeLocal,
  outputSchema: resultShape,
  description:
    "Add one row to a table the business built. The table name must be EXACT, never a partial match. Each value is sent as text and converted to the column's kind; a value that does not fit is refused with the reason. Optionally attach the row to a contact by phone, which requires that contact to already exist.",
  schema: {
    business_id: businessIdField,
    table: tableField,
    values: valuePairsField,
    contact_phone: z
      .string()
      .max(32)
      .optional()
      .describe("Optional. Only for a table whose rows each belong to a contact.")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "operate_messages");
    const { customTableAddRowTool } = await import("@/lib/custom-tables/tool-handlers");
    return await customTableAddRowTool(
      businessId,
      {
        table: args.table,
        values: args.values,
        ...(args.contact_phone ? { contactPhone: args.contact_phone } : {})
      },
      { edit: { source: "mcp" } }
    );
  }
});

export const updateCustomTableRowTool = defineMcpTool({
  name: "update_custom_table_row",
  title: "Change a custom table row",
  annotations: TOOL_BEHAVIOR.mutateLocal,
  outputSchema: resultShape,
  description:
    "Change cells on one existing row. Read the row first with get_custom_table_rows and pass the id it returned. Only the cells sent are changed, and sending a value of empty text clears one. The table name must be EXACT.",
  schema: {
    business_id: businessIdField,
    table: tableField,
    row: z.string().min(1).max(200).describe("Row id from get_custom_table_rows."),
    values: valuePairsField
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "operate_messages");
    const { customTableUpdateRowTool } = await import("@/lib/custom-tables/tool-handlers");
    return await customTableUpdateRowTool(
      businessId,
      { table: args.table, row: args.row, values: args.values },
      { edit: { source: "mcp" } }
    );
  }
});

export const deleteCustomTableRowTool = defineMcpTool({
  name: "delete_custom_table_row",
  title: "Delete a custom table row",
  annotations: TOOL_BEHAVIOR.mutateLocal,
  outputSchema: resultShape,
  description:
    "Delete one row. This takes two calls: the first without confirm deletes nothing and returns what the row says, so you can read it back to the person and wait for a clear yes; only then call again with confirm true. Never guess which row, read it first and pass the id.",
  schema: {
    business_id: businessIdField,
    table: tableField,
    row: z.string().min(1).max(200).describe("Row id from get_custom_table_rows."),
    confirm: z
      .boolean()
      .optional()
      .describe("Only true on the second call, after the person said yes.")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "operate_messages");
    const { customTableDeleteRowTool } = await import("@/lib/custom-tables/tool-handlers");
    return await customTableDeleteRowTool(
      businessId,
      { table: args.table, row: args.row, ...(args.confirm ? { confirm: true } : {}) },
      { edit: { source: "mcp" } }
    );
  }
});

export const createCustomTableTool = defineMcpTool({
  name: "create_custom_table",
  title: "Build a custom table",
  annotations: TOOL_BEHAVIOR.writeLocal,
  outputSchema: resultShape,
  description:
    "Build a new table for this business. The name is the plural of what is being tracked (Properties, Vehicles). Each column has a label and a kind: text, long_text, number, date, checkbox, select, or multi_select; a select or multi_select needs at least two options. Set link_to_contacts only when every row is about one person in the Contacts list. Managers and owners only.",
  schema: {
    business_id: businessIdField,
    name: z.string().min(1).max(60).describe("Table name, plural."),
    description: z.string().max(500).optional().describe("Optional one-line description."),
    link_to_contacts: z
      .boolean()
      .optional()
      .describe("True when each row belongs to one contact."),
    columns: z
      .array(
        z.object({
          label: z.string().min(1).max(60).describe("Column name."),
          type: z
            .enum(["text", "long_text", "number", "date", "checkbox", "select", "multi_select"])
            .optional()
            .describe("Kind of value; defaults to text."),
          options: z
            .array(z.string().max(80))
            .max(20)
            .optional()
            .describe("Choices, for select and multi_select only.")
        })
      )
      .min(1)
      .max(20)
      .describe("The columns to create.")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_settings");
    const { customTableCreateTool } = await import("@/lib/custom-tables/tool-handlers");
    return await customTableCreateTool(
      businessId,
      {
        name: args.name,
        ...(args.description ? { description: args.description } : {}),
        ...(args.link_to_contacts ? { linkToContacts: true } : {}),
        columns: args.columns
      },
      { edit: { source: "mcp" } }
    );
  }
});

export const deleteCustomTableTool = defineMcpTool({
  name: "delete_custom_table",
  title: "Delete a custom table",
  annotations: TOOL_BEHAVIOR.mutateLocal,
  outputSchema: resultShape,
  description:
    "Delete a whole table the business built. This takes two calls: the first without confirm deletes nothing and returns how many rows it holds, so you can tell the person that number and wait for a clear yes; only then call again with confirm true. The table can be brought back for 30 days. Managers and owners only.",
  schema: {
    business_id: businessIdField,
    table: tableField,
    confirm: z
      .boolean()
      .optional()
      .describe("Only true on the second call, after the person said yes.")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_settings");
    const { customTableDeleteTool } = await import("@/lib/custom-tables/tool-handlers");
    return await customTableDeleteTool(
      businessId,
      { table: args.table, ...(args.confirm ? { confirm: true } : {}) },
      { edit: { source: "mcp" } }
    );
  }
});

export const restoreCustomTableTool = defineMcpTool({
  name: "restore_custom_table",
  title: "Restore a deleted table",
  annotations: TOOL_BEHAVIOR.mutateLocal,
  outputSchema: resultShape,
  description:
    "Bring back a table that was deleted, with everything that was in it. Use it when the person changes their mind about a deletion. Managers and owners only.",
  schema: {
    business_id: businessIdField,
    // NOT the shared tableField: that one points at list_custom_tables,
    // which only ever returns LIVE tables, so a deleted one is structurally
    // absent from it. Steering restore at that list would have the model
    // conclude the table is gone instead of bringing it back. A name that
    // matches nothing in the trash comes back with the deleted names listed,
    // so a guess costs one round trip rather than a dead end.
    table: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Name of the DELETED table to bring back, as the person calls it. Deleted tables are not in list_custom_tables, so use the name they gave you; if it does not match, the reply lists what is actually in the trash."
      )
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_settings");
    const { customTableRestoreTool } = await import("@/lib/custom-tables/tool-handlers");
    return await customTableRestoreTool(
      businessId,
      { table: args.table },
      // Just the surface: the core appends the _restore suffix itself, so
      // naming it here would file the undo as "mcp_restore_restore".
      { edit: { source: "mcp" } }
    );
  }
});

export const customTableTools = [
  listCustomTablesTool,
  getCustomTableRowsTool,
  createCustomTableRowTool,
  updateCustomTableRowTool,
  deleteCustomTableRowTool,
  createCustomTableTool,
  deleteCustomTableTool,
  restoreCustomTableTool
];
