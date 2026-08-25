/**
 * Shared cores for the coworker's custom-table tools, used by BOTH
 * dashboard-chat turn paths:
 *
 *   - the INLINE primary path (src/lib/dashboard-chat/action-tools.ts), and
 *   - the Rowboat fallback path (/api/rowboat/tool-call, the over-budget /
 *     no-platform-key worker turns, names prefixed `dashboard_`).
 *
 * One implementation keeps the two byte-identical in behaviour. Result
 * objects go back to the model verbatim, so the wording here is model-facing
 * steering, not UI copy.
 *
 * WHY THESE TOOLS ARE GENERIC. The Rowboat seed is one jq program rendered
 * identically for every tenant at provision time, and TOOL_GATES is a static
 * fail-closed allowlist. Per-tenant tool names (`add_row_to_inspections`)
 * are therefore not merely awkward, they are impossible: the parity test
 * executes that single program and asserts an exact name set, and a dynamic
 * name would need either a fail-open dispatcher or a live-box reseed on
 * every table rename. So the table is a runtime PARAMETER, resolved by name,
 * which is the same shape `dashboard_document_list` already uses for an
 * unbounded per-tenant document set.
 *
 * THE READ/WRITE ASYMMETRY is the safety property worth stating up front.
 * A read may resolve a table by a unique substring; a WRITE must be given
 * the exact name or the id. A read that lands on the wrong table shows the
 * wrong data, which the owner notices. A write that lands on the wrong table
 * corrupts it quietly, and a delete is worse still.
 */
import { z } from "zod";
import { logger } from "@/lib/logger";
import {
  coerceFieldValue,
  describeRowErrors,
  formatRowSummary,
  matchRowsByQuery,
  resolveFieldReference,
  resolveRowReference,
  resolveTableReference,
  slugifyFieldId,
  validateRowValues
} from "@/lib/custom-tables/core";
import {
  CustomTableError,
  countCustomTableRows,
  createCustomTable,
  createCustomTableRow,
  deleteCustomTableRow,
  getCustomTableRow,
  listCustomTableRows,
  listCustomTables,
  listDeletedCustomTables,
  patchCustomTableFields,
  restoreCustomTable,
  softDeleteCustomTable,
  updateCustomTableRow
} from "@/lib/custom-tables/db";
import {
  listCustomTableVersions,
  restoreCustomTableVersion
} from "@/lib/custom-tables/versions";
import { buildCustomTableHistory } from "@/lib/custom-tables/version-history";
import { getCustomerMemory } from "@/lib/customer-memory/db";
import {
  CUSTOM_TABLE_FIELD_TYPES,
  CUSTOM_TABLE_TRASH_RETENTION_DAYS,
  MAX_FIELDS_PER_TABLE,
  MAX_ROWS_PER_TABLE,
  type CustomTable,
  type CustomTableFieldValue
} from "@/lib/custom-tables/types";

/** Every core answers this shape; the model reads it verbatim. */
export type CustomTableToolResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; message: string };

/** Rows a find returns at once. Enough to answer, small enough to read. */
export const CUSTOM_TABLE_TOOL_ROW_LIMIT = 25;

/**
 * Rows fetched per scan page.
 *
 * 1000 is the PostgREST ceiling, and MAX_ROWS_PER_TABLE is 5000, so a full
 * scan is at most five round trips. It used to be one page of 200, which
 * meant a table's older rows were invisible: a search reported "nothing
 * matches" for a row that exists, and an update or delete with a REAL row id
 * refused as row_not_found. A false negative is worse than an error, because
 * the model relays it as fact.
 */
const SCAN_PAGE = 1000;

/** Hard stop for a full scan, so a runaway cursor cannot loop forever. */
const MAX_SCAN_PAGES = Math.ceil(MAX_ROWS_PER_TABLE / SCAN_PAGE) + 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CustomTableToolDeps = {
  listTables?: typeof listCustomTables;
  listDeleted?: typeof listDeletedCustomTables;
  listRows?: typeof listCustomTableRows;
  getRow?: typeof getCustomTableRow;
  countRows?: typeof countCustomTableRows;
  createTable?: typeof createCustomTable;
  patchFields?: typeof patchCustomTableFields;
  softDelete?: typeof softDeleteCustomTable;
  restoreTable?: typeof restoreCustomTable;
  createRow?: typeof createCustomTableRow;
  updateRow?: typeof updateCustomTableRow;
  deleteRow?: typeof deleteCustomTableRow;
  listVersions?: typeof listCustomTableVersions;
  restoreVersion?: typeof restoreCustomTableVersion;
  lookupContact?: typeof getCustomerMemory;
  /** Who to record on the history row. */
  edit?: { source?: string; actor?: string | null };
};

// ---------------------------------------------------------------------------
// Arg schemas, in lockstep with /api/rowboat/tool-call
// ---------------------------------------------------------------------------

/**
 * Values arrive as an ARRAY of {field, value} string pairs, not an open
 * object. Rowboat and Gemini function-calling schemas are unreliable with
 * `additionalProperties` and union-typed values, so every value comes in as
 * a string and coerceFieldValue does the typed conversion in one tested
 * place. `field` is the LABEL the model saw in custom_table_list.
 */
const valuePairsSchema = z
  .array(
    z.object({
      field: z.string().min(1).max(80),
      value: z.string().max(4000)
    })
  )
  .max(MAX_FIELDS_PER_TABLE);

export const customTableListArgsSchema = z.object({}).passthrough();

export const customTableFindRowsArgsSchema = z.object({
  table: z.string().min(1).max(200),
  query: z.string().max(200).optional(),
  contactPhone: z.string().max(32).optional(),
  limit: z.number().int().min(1).max(CUSTOM_TABLE_TOOL_ROW_LIMIT).optional()
});

export const customTableAddRowArgsSchema = z.object({
  table: z.string().min(1).max(200),
  values: valuePairsSchema,
  contactPhone: z.string().max(32).optional()
});

export const customTableUpdateRowArgsSchema = z.object({
  table: z.string().min(1).max(200),
  row: z.string().min(1).max(200),
  values: valuePairsSchema
});

export const customTableDeleteRowArgsSchema = z.object({
  table: z.string().min(1).max(200),
  row: z.string().min(1).max(200),
  confirm: z.boolean().optional()
});

export const customTableHistoryArgsSchema = z.object({
  table: z.string().min(1).max(200)
});

export const customTableCreateArgsSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  linkToContacts: z.boolean().optional(),
  columns: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        type: z.enum(CUSTOM_TABLE_FIELD_TYPES).optional(),
        options: z.array(z.string().max(80)).max(20).optional()
      })
    )
    .min(1)
    .max(MAX_FIELDS_PER_TABLE)
});

export const customTableUpdateSchemaArgsSchema = z.object({
  table: z.string().min(1).max(200),
  action: z.enum(["add_column", "rename_column", "delete_column"]),
  column: z.string().min(1).max(80),
  newName: z.string().max(60).optional(),
  type: z.enum(CUSTOM_TABLE_FIELD_TYPES).optional(),
  options: z.array(z.string().max(80)).max(20).optional(),
  confirm: z.boolean().optional()
});

export const customTableDeleteArgsSchema = z.object({
  table: z.string().min(1).max(200),
  confirm: z.boolean().optional()
});

export const customTableRestoreArgsSchema = z.object({
  table: z.string().min(1).max(200)
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------


/**
 * Fill in the production cores once.
 *
 * Every `?? default` here is a branch tests never take, because tests always
 * inject. Resolving them in ONE place keeps that from being eleven uncovered
 * branches scattered through the file, the same shape action-tools.ts uses.
 */
/* c8 ignore start -- production defaults; tests inject */
function resolved(deps: CustomTableToolDeps) {
  return {
    listTables: deps.listTables ?? listCustomTables,
    listDeleted: deps.listDeleted ?? listDeletedCustomTables,
    listRows: deps.listRows ?? listCustomTableRows,
    getRow: deps.getRow ?? getCustomTableRow,
    countRows: deps.countRows ?? countCustomTableRows,
    createTable: deps.createTable ?? createCustomTable,
    patchFields: deps.patchFields ?? patchCustomTableFields,
    softDelete: deps.softDelete ?? softDeleteCustomTable,
    restoreTable: deps.restoreTable ?? restoreCustomTable,
    createRow: deps.createRow ?? createCustomTableRow,
    updateRow: deps.updateRow ?? updateCustomTableRow,
    deleteRow: deps.deleteRow ?? deleteCustomTableRow,
    listVersions: deps.listVersions ?? listCustomTableVersions,
    restoreVersion: deps.restoreVersion ?? restoreCustomTableVersion,
    lookupContact: deps.lookupContact ?? getCustomerMemory,
    edit: deps.edit ?? { source: "ai" },
    // A restore is attributed as a restore, so the history reads "Restored
    // from history" rather than "Changed by your coworker". Derived from the
    // caller's surface rather than replaced by it: taking `deps.edit`
    // wholesale meant every production path (which always supplies one)
    // filed its undos as ordinary edits.
    restoreEdit: {
      source: `${deps.edit?.source ?? "ai"}_restore`,
      actor: deps.edit?.actor ?? null
    }
  };
}
/* c8 ignore stop */

function failure(message: string): CustomTableToolResult {
  return { ok: false, message };
}

/** Turn a typed db failure into model-facing steering rather than a stack. */
function relay(err: unknown, fallback: string): CustomTableToolResult {
  if (err instanceof CustomTableError) return failure(err.message);
  throw err instanceof Error ? err : new Error(fallback);
}

/**
 * Resolve the table the model named.
 *
 * `exactOnly` is passed by every WRITE. On a miss or an ambiguity the
 * refusal lists the real table names, because a model that is told what
 * exists asks the owner instead of guessing again.
 */
async function resolveTable(
  businessId: string,
  ref: string,
  exactOnly: boolean,
  listTables: typeof listCustomTables
): Promise<{ ok: true; table: CustomTable } | { ok: false; result: CustomTableToolResult }> {
  const tables = await listTables(businessId);
  if (tables.length === 0) {
    return {
      ok: false,
      result: failure(
        "no_tables: this business has not made any custom tables yet. Tell the owner they can create one at /dashboard/tables, or offer to create it for them."
      )
    };
  }
  const found = resolveTableReference(tables, ref, exactOnly);
  if (found.ok) return { ok: true, table: found.table };
  const names = tables.map((t) => t.name).join(", ");
  if (found.detail === "table_ambiguous") {
    return {
      ok: false,
      result: failure(
        `table_ambiguous: "${ref}" matches more than one table. Ask the owner which one they mean. The tables are: ${names}.`
      )
    };
  }
  return {
    ok: false,
    result: failure(
      `table_not_found: there is no table matching "${ref}"${
        exactOnly ? " (writes need the exact table name)" : ""
      }. The tables are: ${names}.`
    )
  };
}

/**
 * Turn the phone the model supplied into a contact id.
 *
 * The contact must ALREADY exist, which is the same rule the CSV importer
 * draws: a record without its person is meaningless, and inventing a bare
 * contact here would bypass the contacts path that owns dedupe and merge.
 * A miss refuses honestly rather than filing the row under nobody.
 */
async function resolveContact(
  businessId: string,
  table: CustomTable,
  phone: string,
  lookup: typeof getCustomerMemory
): Promise<{ ok: true; contactId: string } | { ok: false; result: CustomTableToolResult }> {
  const contact = await lookup(businessId, phone.trim());
  if (!contact) {
    return {
      ok: false,
      result: failure(
        `contact_not_found: there is no contact with the number ${phone.trim()}, so the row cannot be attached to them. Add the contact first, or add the row without a number and let the owner attach it.`
      )
    };
  }
  return { ok: true, contactId: contact.id };
}

/**
 * Every row of a table, paged.
 *
 * Callers need the whole table, not its newest page: an owner asking about a
 * row they added last year is the normal case, and a bounded scan that
 * silently stopped would answer "no such row".
 */
async function scanAllRows(
  table: CustomTable,
  listRows: typeof listCustomTableRows,
  options: { contactId?: string } = {}
) {
  const all: Awaited<ReturnType<typeof listCustomTableRows>>["rows"] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const got: Awaited<ReturnType<typeof listCustomTableRows>> = await listRows(
      table.id,
      table.fields,
      { limit: SCAN_PAGE, cursor, ...(options.contactId ? { contactId: options.contactId } : {}) }
    );
    all.push(...got.rows);
    if (!got.nextCursor) break;
    cursor = got.nextCursor;
  }
  return all;
}

/**
 * Find the row the model named.
 *
 * A uuid is fetched DIRECTLY, one query, no scan: that is the common case,
 * because find_rows hands the model an id and the write tools tell it to use
 * one. Anything else falls back to matching the rendered summary across the
 * whole table.
 */
async function findRow(
  table: CustomTable,
  ref: string,
  d: { listRows: typeof listCustomTableRows; getRow: typeof getCustomTableRow },
  verb: string
): Promise<
  | { ok: true; row: Awaited<ReturnType<typeof getCustomTableRow>> }
  | { ok: false; result: CustomTableToolResult }
> {
  if (UUID_RE.test(ref.trim())) {
    try {
      return { ok: true, row: await d.getRow(table.id, ref.trim(), table.fields) };
    } catch (err) {
      if (err instanceof CustomTableError) {
        return {
          ok: false,
          result: failure(`row_not_found: no row in "${table.name}" has the id ${ref.trim()}.`)
        };
      }
      throw err;
    }
  }
  const rows = await scanAllRows(table, d.listRows);
  const found = resolveRowReference(table.fields, rows, ref);
  if (found.ok) return { ok: true, row: found.row };
  return {
    ok: false,
    result: failure(
      found.detail === "row_ambiguous"
        ? `row_ambiguous: more than one row in "${table.name}" matches "${ref}". ${verb}`
        : `row_not_found: no row in "${table.name}" matches "${ref}". Find it first with custom_table_find_rows.`
    )
  };
}

/** One row rendered for the model: an addressable id plus a readable line. */
function renderRow(
  table: CustomTable,
  row: { id: string; values: Record<string, CustomTableFieldValue> }
) {
  return { id: row.id, summary: formatRowSummary(table.fields, row) };
}

/**
 * Turn {field,value} label pairs into a validated value bag.
 *
 * An unrecognized label is an explicit refusal naming the real columns, not
 * a silent drop: silently dropping is how an AI reports saving something
 * that is not there.
 */
/**
 * @param partial true for an UPDATE, where the model is changing some cells
 * and the ones it did not mention are simply not being touched. False for a
 * CREATE, which is a whole row and so has to satisfy the required columns.
 */
function buildValues(
  table: CustomTable,
  pairs: { field: string; value: string }[],
  partial: boolean
):
  | { ok: true; values: Record<string, CustomTableFieldValue>; cleared: string[] }
  | { ok: false; result: CustomTableToolResult } {
  const columns = table.fields.filter((f) => f.enabled);
  const labels = columns.map((f) => f.label).join(", ");
  const raw: Record<string, unknown> = {};
  for (const pair of pairs) {
    const found = resolveFieldReference(columns, pair.field);
    if (!found.ok) {
      return {
        ok: false,
        result: failure(
          `unknown_column: "${table.name}" has no column called "${pair.field}". Its columns are: ${labels}.`
        )
      };
    }
    // Empty means CLEAR, and it has to short-circuit before coercion.
    // Coercing "" for a number or a date or a choice column fails, so
    // running it first meant the coworker could only ever empty a text
    // cell: every other kind came back "is the wrong kind of value".
    if (pair.value.trim() === "") {
      raw[found.field.id] = "";
      continue;
    }
    const coerced = coerceFieldValue(found.field, pair.value);
    if (!coerced.ok) {
      return {
        ok: false,
        result: failure(
          `bad_value: ${describeRowErrors(columns, [
            { fieldId: found.field.id, code: coerced.code }
          ])}`
        )
      };
    }
    raw[found.field.id] = coerced.value;
  }
  const checked = validateRowValues(columns, raw, { partial });
  if (!checked.ok) {
    return { ok: false, result: failure(`bad_value: ${describeRowErrors(columns, checked.errors)}`) };
  }
  return { ok: true, values: checked.values, cleared: checked.cleared };
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

/**
 * Every table with its COLUMN DEFINITIONS and row count.
 *
 * The definitions are what make a write possible without a second round
 * trip, and they are the difference between this and document_list: the
 * model needs to know a column is called "Status" and only accepts
 * New / Won / Lost before it tries to set one.
 */
export async function customTableListTool(
  businessId: string,
  deps: CustomTableToolDeps = {}
): Promise<CustomTableToolResult> {
  const d = resolved(deps);
  const tables = await d.listTables(businessId);
  if (tables.length === 0) {
    return {
      ok: true,
      tables: [],
      note: "This business has no custom tables yet. Offer to make one if the owner describes something they want to keep track of."
    };
  }
  const described = await Promise.all(
    tables.map(async (table) => ({
      name: table.name,
      description: table.description ?? undefined,
      rowsBelongTo: table.rowLink === "contact" ? "one contact each" : "nothing in particular",
      rowCount: await d.countRows(table.id),
      columns: table.fields
        .filter((f) => f.enabled)
        .map((f) => ({
          name: f.label,
          type: f.type,
          ...(f.options ? { choices: f.options } : {}),
          ...(f.required ? { required: true } : {})
        }))
    }))
  );
  return {
    ok: true,
    tables: described,
    note: "Use the table's exact name when adding, changing, or deleting anything. Only set a column that is listed here, and for a choice column only one of its listed choices."
  };
}

/** Rows matching a search, or every row about one contact. */
export async function customTableFindRowsTool(
  businessId: string,
  args: z.infer<typeof customTableFindRowsArgsSchema>,
  deps: CustomTableToolDeps = {}
): Promise<CustomTableToolResult> {
  const d = resolved(deps);
  // Reads may resolve on a unique substring: showing the wrong table is
  // visible to the owner in a way a wrong WRITE is not.
  const rt = await resolveTable(businessId, args.table, false, d.listTables);
  if (!rt.ok) return rt.result;
  const table = rt.table;

  if (args.contactPhone && table.rowLink !== "contact") {
    return failure(
      `not_contact_linked: rows in "${table.name}" do not belong to a contact, so they cannot be looked up by phone number. Search it with the query argument instead.`
    );
  }

  let contactId: string | undefined;
  if (args.contactPhone) {
    const contact = await resolveContact(businessId, table, args.contactPhone, d.lookupContact);
    if (!contact.ok) return contact.result;
    contactId = contact.contactId;
  }
  const scanned = await scanAllRows(table, d.listRows, contactId ? { contactId } : {});
  const matched = args.query ? matchRowsByQuery(table.fields, scanned, args.query) : scanned;
  const limit = args.limit ?? CUSTOM_TABLE_TOOL_ROW_LIMIT;
  const rows = matched.slice(0, limit).map((row) => renderRow(table, row));
  return {
    ok: true,
    table: table.name,
    rows,
    ...(matched.length > rows.length
      ? { note: `Showing ${rows.length} of ${matched.length} matches. Narrow the search to see the rest.` }
      : {}),
    ...(rows.length === 0
      ? { note: `Nothing in "${table.name}" matches that. Say so plainly rather than guessing at what is in it.` }
      : {})
  };
}

/** Recent changes, in the same plain English the dashboard panel shows. */
export async function customTableHistoryTool(
  businessId: string,
  args: z.infer<typeof customTableHistoryArgsSchema>,
  deps: CustomTableToolDeps = {}
): Promise<CustomTableToolResult> {
  const d = resolved(deps);
  const rt = await resolveTable(businessId, args.table, false, d.listTables);
  if (!rt.ok) return rt.result;
  const table = rt.table;
  const versions = await d.listVersions(businessId, table.id);
  // Only the rows this history actually mentions, fetched by id. Reading a
  // page instead meant an older row's edits were described as "changed a row
  // that was deleted later" purely because it fell off the newest page.
  const rowIds = [...new Set(versions.map((v) => v.rowId).filter((id): id is string => !!id))];
  const live = new Map<string, Record<string, unknown>>();
  for (const rowId of rowIds) {
    try {
      const row = await d.getRow(table.id, rowId, table.fields);
      live.set(rowId, row.values as Record<string, unknown>);
    } catch (err) {
      // A row that is genuinely gone stays absent, which is what the builder
      // reads as "changed a row that was deleted later".
      if (!(err instanceof CustomTableError)) throw err;
    }
  }
  const entries = buildCustomTableHistory(versions, table, live).map((entry) => ({
    id: entry.versionId,
    when: entry.replacedAt,
    by: entry.by,
    changed: entry.changeSummary,
    canUndo: entry.restorable
  }));
  return {
    ok: true,
    table: table.name,
    changes: entries,
    note:
      entries.length === 0
        ? "Nothing has changed on this table yet."
        : "To undo one, call custom_table_undo with its id. Read the change back to the owner first and wait for a yes."
  };
}

// ---------------------------------------------------------------------------
// Row writes
// ---------------------------------------------------------------------------

export async function customTableAddRowTool(
  businessId: string,
  args: z.infer<typeof customTableAddRowArgsSchema>,
  deps: CustomTableToolDeps = {}
): Promise<CustomTableToolResult> {
  const d = resolved(deps);
  const rt = await resolveTable(businessId, args.table, true, d.listTables);
  if (!rt.ok) return rt.result;
  const table = rt.table;

  if (args.contactPhone && table.rowLink !== "contact") {
    return failure(
      `not_contact_linked: rows in "${table.name}" do not belong to a contact, so a phone number cannot be attached to one.`
    );
  }
  // Not partial: adding a row is a whole row, so the required columns hold.
  const built = buildValues(table, args.values, false);
  if (!built.ok) return built.result;

  let contactId: string | null = null;
  if (args.contactPhone) {
    const contact = await resolveContact(businessId, table, args.contactPhone, d.lookupContact);
    if (!contact.ok) return contact.result;
    contactId = contact.contactId;
  }

  try {
    const row = await d.createRow(
      businessId,
      table,
      { values: built.values, contactId },
      d.edit
    );
    return {
      ok: true,
      table: table.name,
      rowId: row.id,
      summary: formatRowSummary(table.fields, row),
      note:
        table.rowLink === "contact" && !contactId
          ? `Added to "${table.name}". It is not attached to a contact yet; give a contactPhone next time, or tell the owner they can pick one at /dashboard/tables.`
          : `Added to "${table.name}".`
    };
  } catch (err) {
    return relay(err, "customTableAddRowTool failed");
  }
}

export async function customTableUpdateRowTool(
  businessId: string,
  args: z.infer<typeof customTableUpdateRowArgsSchema>,
  deps: CustomTableToolDeps = {}
): Promise<CustomTableToolResult> {
  const d = resolved(deps);
  const rt = await resolveTable(businessId, args.table, true, d.listTables);
  if (!rt.ok) return rt.result;
  const table = rt.table;

  const found = await findRow(
    table,
    args.row,
    d,
    "Find the row first with custom_table_find_rows and use the id it returns."
  );
  if (!found.ok) return found.result;
  // Partial: the model is changing SOME cells, and a required column it did
  // not mention is one nobody is touching. Without this, marking any column
  // required would make every other cell uneditable by the coworker, which
  // is the same bug the dashboard grid had.
  const built = buildValues(table, args.values, true);
  if (!built.ok) return built.result;

  try {
    const row = await d.updateRow(
      table,
      found.row.id,
      { values: built.values, clear: built.cleared },
      d.edit
    );
    return {
      ok: true,
      table: table.name,
      rowId: row.id,
      summary: formatRowSummary(table.fields, row),
      note: "Read the row back to the owner so they can see what it says now."
    };
  } catch (err) {
    return relay(err, "customTableUpdateRowTool failed");
  }
}

export async function customTableDeleteRowTool(
  businessId: string,
  args: z.infer<typeof customTableDeleteRowArgsSchema>,
  deps: CustomTableToolDeps = {}
): Promise<CustomTableToolResult> {
  const d = resolved(deps);
  const rt = await resolveTable(businessId, args.table, true, d.listTables);
  if (!rt.ok) return rt.result;
  const table = rt.table;

  const found = await findRow(
    table,
    args.row,
    d,
    "Never guess which to delete: find it with custom_table_find_rows and use the id."
  );
  if (!found.ok) return found.result;
  const summary = formatRowSummary(table.fields, found.row);

  // Confirm is a real gate, not a formality: this is the one row-level
  // action that destroys data, so the owner has to hear what is going
  // before it does.
  if (args.confirm !== true) {
    return failure(
      `needs_confirmation: read this row back to the owner and ask whether to delete it, then call again with confirm true. The row says: ${summary || "(empty)"}.`
    );
  }

  try {
    await d.deleteRow(table.id, found.row.id, d.edit);
    return {
      ok: true,
      table: table.name,
      deleted: summary,
      note: "Deleted. It can be put back from Recent changes, so tell the owner that if they change their mind."
    };
  } catch (err) {
    return relay(err, "customTableDeleteRowTool failed");
  }
}

/** Put back a version, a deleted row, or a whole deleted table. */
export async function customTableUndoTool(
  businessId: string,
  args: { changeId: number },
  deps: CustomTableToolDeps = {}
): Promise<CustomTableToolResult> {
  const d = resolved(deps);
  try {
    const outcome = await d.restoreVersion(businessId, args.changeId, d.restoreEdit);
    return {
      ok: true,
      undid: outcome.kind,
      note:
        outcome.kind === "row_recreated"
          ? "The row is back, with a new id. Tell the owner it has been restored."
          : "Put back. Tell the owner what was restored."
    };
  } catch (err) {
    return relay(err, "customTableUndoTool failed");
  }
}

// ---------------------------------------------------------------------------
// Schema writes
// ---------------------------------------------------------------------------

export async function customTableCreateTool(
  businessId: string,
  args: z.infer<typeof customTableCreateArgsSchema>,
  deps: CustomTableToolDeps = {}
): Promise<CustomTableToolResult> {
  const d = resolved(deps);
  const fields = [] as Parameters<typeof createCustomTable>[1]["fields"];
  for (const column of args.columns) {
    const type = column.type ?? "text";
    const options = (column.options ?? []).map((o) => o.trim()).filter(Boolean);
    if ((type === "select" || type === "multi_select") && options.length < 2) {
      return failure(
        `bad_column: "${column.label}" is a choice column, so it needs at least two choices. Ask the owner what the choices should be.`
      );
    }
    fields.push({
      id: slugifyFieldId(column.label, fields.map((f) => f.id)),
      label: column.label.trim(),
      type,
      ...(options.length > 0 ? { options } : {}),
      required: false,
      enabled: true
    });
  }
  try {
    const table = await d.createTable(businessId, {
      name: args.name,
      description: args.description ?? null,
      rowLink: args.linkToContacts === true ? "contact" : "standalone",
      fields
    });
    return {
      ok: true,
      table: table.name,
      columns: table.fields.map((f) => f.label),
      note: `Made "${table.name}". Tell the owner it is at /dashboard/tables and offer to start filling it in.`
    };
  } catch (err) {
    return relay(err, "customTableCreateTool failed");
  }
}

export async function customTableUpdateSchemaTool(
  businessId: string,
  args: z.infer<typeof customTableUpdateSchemaArgsSchema>,
  deps: CustomTableToolDeps = {}
): Promise<CustomTableToolResult> {
  const d = resolved(deps);
  const rt = await resolveTable(businessId, args.table, true, d.listTables);
  if (!rt.ok) return rt.result;
  const table = rt.table;
  const labels = table.fields.map((f) => f.label).join(", ");

  if (args.action === "add_column") {
    const type = args.type ?? "text";
    const options = (args.options ?? []).map((o) => o.trim()).filter(Boolean);
    if ((type === "select" || type === "multi_select") && options.length < 2) {
      return failure(
        `bad_column: a choice column needs at least two choices. Ask the owner what they should be.`
      );
    }
    try {
      const { table: next } = await d.patchFields(
        businessId,
        table.id,
        {
          action: "add",
          label: args.column,
          type,
          ...(options.length > 0 ? { options } : {})
        },
        d.edit
      );
      return {
        ok: true,
        table: next.name,
        columns: next.fields.map((f) => f.label),
        note: `Added the "${args.column}" column. Existing rows have it empty.`
      };
    } catch (err) {
      return relay(err, "customTableUpdateSchemaTool failed");
    }
  }

  const target = resolveFieldReference(table.fields, args.column);
  if (!target.ok) {
    return failure(
      `unknown_column: "${table.name}" has no column called "${args.column}". Its columns are: ${labels}.`
    );
  }

  if (args.action === "rename_column") {
    const newName = args.newName?.trim();
    if (!newName) {
      return failure("missing_new_name: say what the column should be called instead.");
    }
    try {
      const { table: next } = await d.patchFields(
        businessId,
        table.id,
        { action: "update", fieldId: target.field.id, label: newName },
        d.edit
      );
      return {
        ok: true,
        table: next.name,
        columns: next.fields.map((f) => f.label),
        note: `Renamed it to "${newName}". Nothing written in it changed.`
      };
    } catch (err) {
      return relay(err, "customTableUpdateSchemaTool failed");
    }
  }

  // delete_column destroys every value in that column, on every row, and no
  // per-row undo covers it. It gets the same confirm gate as a row delete.
  if (args.confirm !== true) {
    return failure(
      `needs_confirmation: deleting the "${target.field.label}" column also deletes what is written in it on every row of "${table.name}". Ask the owner whether they are sure, then call again with confirm true.`
    );
  }
  try {
    const { table: next, sweptRows } = await d.patchFields(
      businessId,
      table.id,
      { action: "remove", fieldId: target.field.id },
      d.edit
    );
    return {
      ok: true,
      table: next.name,
      columns: next.fields.map((f) => f.label),
      note: `Deleted the "${target.field.label}" column and cleared it from ${sweptRows} row(s).`
    };
  } catch (err) {
    return relay(err, "customTableUpdateSchemaTool failed");
  }
}

export async function customTableDeleteTool(
  businessId: string,
  args: z.infer<typeof customTableDeleteArgsSchema>,
  deps: CustomTableToolDeps = {}
): Promise<CustomTableToolResult> {
  const d = resolved(deps);
  const rt = await resolveTable(businessId, args.table, true, d.listTables);
  if (!rt.ok) return rt.result;
  const table = rt.table;

  if (args.confirm !== true) {
    const rows = await d.countRows(table.id);
    return failure(
      `needs_confirmation: "${table.name}" has ${rows} row(s). Tell the owner that number, ask whether to delete the whole table, and only call again with confirm true if they say yes.`
    );
  }
  try {
    await d.softDelete(businessId, table.id, null, d.edit);
    logger.info("custom table deleted by coworker", { businessId, tableId: table.id });
    return {
      ok: true,
      table: table.name,
      note: `Deleted "${table.name}". It can be brought back for ${CUSTOM_TABLE_TRASH_RETENTION_DAYS} days, from /dashboard/tables or by asking. Tell the owner that.`
    };
  } catch (err) {
    return relay(err, "customTableDeleteTool failed");
  }
}

export async function customTableRestoreTool(
  businessId: string,
  args: z.infer<typeof customTableRestoreArgsSchema>,
  deps: CustomTableToolDeps = {}
): Promise<CustomTableToolResult> {
  const d = resolved(deps);
  const trashed = await d.listDeleted(businessId);
  if (trashed.length === 0) {
    return failure("nothing_deleted: no table of this business is in the trash.");
  }
  const found = resolveTableReference(trashed, args.table, false);
  if (!found.ok) {
    const names = trashed.map((t) => t.name).join(", ");
    return failure(
      found.detail === "table_ambiguous"
        ? `table_ambiguous: more than one deleted table matches "${args.table}". The deleted tables are: ${names}.`
        : `table_not_found: no deleted table matches "${args.table}". The deleted tables are: ${names}.`
    );
  }
  try {
    const table = await d.restoreTable(businessId, found.table.id, d.restoreEdit);
    return {
      ok: true,
      table: table.name,
      note: `"${table.name}" is back, with everything that was in it.`
    };
  } catch (err) {
    return relay(err, "customTableRestoreTool failed");
  }
}
