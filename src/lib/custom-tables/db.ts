/**
 * Supabase access for custom tables and their rows (service-role only;
 * authorization is the API route's job via requireBusinessRole, same trust
 * model as the pipelines / customers / employees db modules).
 *
 * ATTRIBUTION: every mutating call takes an `edit` stamp and writes it into
 * the same UPDATE statement. The database trigger copies it onto the history
 * row and then clears it, so `edit_source` / `edit_actor` always read back
 * null. Do not SELECT them to learn who changed something; read
 * custom_table_versions, whose newest row carries the provenance of the
 * state that is live right now.
 *
 * A writer that forgets to stamp still gets a history row, just an
 * unattributed one. The load-bearing half (the old values) is never at the
 * writer's discretion, because it is the trigger's job, not the caller's.
 *
 * ROW DELETES ARE THE EXCEPTION and deleteCustomTableRow explains why: a
 * BEFORE DELETE trigger has no NEW row to carry a stamp, and pre-stamping
 * the row in its own UPDATE cannot work because the update trigger consumes
 * the carrier. There, the trigger still writes the snapshot and the app
 * labels it afterwards.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import {
  applyFieldDefinitionPatch,
  parseTableFields,
  projectRowValues,
  type FieldDefinitionPatch
} from "@/lib/custom-tables/core";
import {
  CUSTOM_TABLE_TRASH_RETENTION_DAYS,
  MAX_ROWS_PER_TABLE,
  MAX_TABLES_PER_BUSINESS,
  normalizeTableIcon,
  type CustomTable,
  type CustomTableField,
  type CustomTableFieldValue,
  type CustomTableRow,
  type CustomTableRowLink,
  type CustomTableRowWithContact
} from "@/lib/custom-tables/types";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Typed failure the API routes and the AI tool handlers map onto responses. */
export class CustomTableError extends Error {
  constructor(
    public readonly code: "not_found" | "limit" | "duplicate" | "invalid" | "ambiguous",
    message: string
  ) {
    super(message);
    this.name = "CustomTableError";
  }
}

/**
 * Who made a change, for the history row. Both halves optional: an
 * unattributed edit reads as "nobody said", never as a surface.
 */
export type EditStamp = { source?: string; actor?: string | null };

/** One page of rows. MAX_ROWS_PER_TABLE / this is the sweep's page bound. */
export const CUSTOM_TABLE_ROWS_PAGE_SIZE = 200;

/** Page size for the column-delete sweep, matching RETAG_PAGE_SIZE. */
export const FIELD_SWEEP_PAGE_SIZE = 1000;

const TABLE_COLUMNS =
  "id, business_id, name, description, icon, row_link, fields, position, deleted_at, created_at, updated_at";
const ROW_COLUMNS =
  "id, table_id, contact_id, field_values, created_at, updated_at";

type TableRow = {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  icon: string | null;
  row_link: string;
  fields: unknown;
  position: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type RowRow = {
  id: string;
  table_id: string;
  contact_id: string | null;
  field_values: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

/**
 * One place resolves the client. Inlining `client ?? await create...` in
 * every function would put the same untaken branch in a dozen places, which
 * is exactly the branch a 100% gate ends up arguing about.
 */
async function resolveClient(client?: SupabaseClient): Promise<SupabaseClient> {
  return client ?? (await createSupabaseServiceClient());
}

function toTable(row: TableRow): CustomTable {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description,
    icon: normalizeTableIcon(row.icon),
    rowLink: row.row_link === "contact" ? "contact" : "standalone",
    fields: parseTableFields(row.fields),
    position: row.position,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toRow(row: RowRow, fields: readonly CustomTableField[]): CustomTableRow {
  return {
    id: row.id,
    tableId: row.table_id,
    contactId: row.contact_id,
    values: projectRowValues(fields, row.field_values),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** The carrier columns, written in the same statement as the change itself. */
function editColumns(edit: EditStamp | undefined) {
  return {
    edit_source: edit?.source ?? null,
    edit_actor: edit?.actor ?? null
  };
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Live tables only. A soft-deleted table is reached through listDeletedTables. */
export async function listCustomTables(
  businessId: string,
  client?: SupabaseClient
): Promise<CustomTable[]> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("custom_tables")
    .select(TABLE_COLUMNS)
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .order("position", { ascending: true });
  if (error) throw new Error(`listCustomTables: ${error.message}`);
  return ((data ?? []) as TableRow[]).map(toTable);
}

/** Soft-deleted tables still inside the restore window. */
export async function listDeletedCustomTables(
  businessId: string,
  client?: SupabaseClient
): Promise<CustomTable[]> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("custom_tables")
    .select(TABLE_COLUMNS)
    .eq("business_id", businessId)
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false });
  if (error) throw new Error(`listDeletedCustomTables: ${error.message}`);
  return ((data ?? []) as TableRow[]).map(toTable);
}

/**
 * One table, scoped to BOTH the business and the id so a URL can never lie
 * about what a call reads or mutates.
 */
export async function getCustomTable(
  businessId: string,
  tableId: string,
  options: { includeDeleted?: boolean } = {},
  client?: SupabaseClient
): Promise<CustomTable> {
  const db = await resolveClient(client);
  let query = db
    .from("custom_tables")
    .select(TABLE_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", tableId);
  if (!options.includeDeleted) query = query.is("deleted_at", null);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`getCustomTable: ${error.message}`);
  if (!data) throw new CustomTableError("not_found", "That table is gone.");
  return toTable(data as TableRow);
}

export async function createCustomTable(
  businessId: string,
  input: {
    name: string;
    description?: string | null;
    icon?: string | null;
    rowLink?: CustomTableRowLink;
    fields: CustomTableField[];
    createdBy?: string | null;
  },
  client?: SupabaseClient
): Promise<CustomTable> {
  const db = await resolveClient(client);
  const existing = await listCustomTables(businessId, db);
  if (existing.length >= MAX_TABLES_PER_BUSINESS) {
    throw new CustomTableError(
      "limit",
      `You can have ${MAX_TABLES_PER_BUSINESS} tables. Delete one to make room.`
    );
  }
  const name = input.name.trim();
  if (existing.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    throw new CustomTableError("duplicate", `You already have a table called "${name}".`);
  }
  const { data, error } = await db
    .from("custom_tables")
    .insert({
      business_id: businessId,
      name,
      description: input.description?.trim() || null,
      icon: normalizeTableIcon(input.icon),
      row_link: input.rowLink ?? "standalone",
      fields: input.fields,
      position: existing.length,
      created_by: input.createdBy ?? null
    })
    .select(TABLE_COLUMNS)
    .maybeSingle();
  // The partial unique index is the real authority: two requests can pass
  // the check above at the same moment and only one can pass this.
  if (error?.code === "23505") {
    throw new CustomTableError("duplicate", `You already have a table called "${name}".`);
  }
  if (error) throw new Error(`createCustomTable: ${error.message}`);
  if (!data) throw new CustomTableError("invalid", "The table was not created.");
  return toTable(data as TableRow);
}

/** Rename or re-describe. The trigger snapshots the prior state. */
export async function updateCustomTableDetails(
  businessId: string,
  tableId: string,
  patch: { name?: string; description?: string | null; icon?: string | null },
  edit?: EditStamp,
  client?: SupabaseClient
): Promise<CustomTable> {
  const db = await resolveClient(client);
  const update: Record<string, unknown> = {
    ...editColumns(edit),
    updated_at: new Date().toISOString()
  };
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.description !== undefined) update.description = patch.description?.trim() || null;
  if (patch.icon !== undefined) update.icon = normalizeTableIcon(patch.icon);
  const { data, error } = await db
    .from("custom_tables")
    .update(update)
    .eq("business_id", businessId)
    .eq("id", tableId)
    .is("deleted_at", null)
    .select(TABLE_COLUMNS)
    .maybeSingle();
  if (error?.code === "23505") {
    throw new CustomTableError("duplicate", `You already have a table called "${patch.name}".`);
  }
  if (error) throw new Error(`updateCustomTableDetails: ${error.message}`);
  if (!data) throw new CustomTableError("not_found", "That table is gone.");
  return toTable(data as TableRow);
}

/**
 * Apply one column edit and, when a column went away, sweep its key out of
 * every row.
 *
 * Optimistic concurrency on `updated_at`: two managers editing columns at
 * once would otherwise last-write-wins, and a silently lost COLUMN is worse
 * than a silently lost stage reorder. The loser is told to reload rather
 * than having their work vanish.
 */
export async function patchCustomTableFields(
  businessId: string,
  tableId: string,
  patch: FieldDefinitionPatch,
  edit?: EditStamp,
  client?: SupabaseClient
): Promise<{ table: CustomTable; sweptRows: number }> {
  const db = await resolveClient(client);
  const current = await getCustomTable(businessId, tableId, {}, db);
  const applied = applyFieldDefinitionPatch(current.fields, patch);
  if (!applied.ok) {
    if (applied.code === "not_found") throw new CustomTableError("not_found", applied.message);
    if (applied.code === "limit") throw new CustomTableError("limit", applied.message);
    if (applied.code === "duplicate") throw new CustomTableError("duplicate", applied.message);
    throw new CustomTableError("invalid", applied.message);
  }
  const { data, error } = await db
    .from("custom_tables")
    .update({
      fields: applied.fields,
      ...editColumns(edit),
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId)
    .eq("id", tableId)
    .eq("updated_at", current.updatedAt)
    .select(TABLE_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`patchCustomTableFields: ${error.message}`);
  if (!data) {
    throw new CustomTableError(
      "invalid",
      "Someone else changed this table's columns while you were editing. Reload and try again."
    );
  }
  const sweptRows = await sweepRemovedFields(tableId, applied.removedFieldIds, db);
  return { table: toTable(data as TableRow), sweptRows };
}

/**
 * Soft delete. Rows are untouched, so restoring is one stamp-clear rather
 * than a resurrection. The nightly sweep hard-deletes later, which cascades
 * the rows, so this never extends how long data lives.
 */
export async function softDeleteCustomTable(
  businessId: string,
  tableId: string,
  deletedBy: string | null,
  edit?: EditStamp,
  client?: SupabaseClient
): Promise<void> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("custom_tables")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: deletedBy,
      ...editColumns(edit),
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId)
    .eq("id", tableId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`softDeleteCustomTable: ${error.message}`);
  if (!data) throw new CustomTableError("not_found", "That table is gone.");
}

export async function restoreCustomTable(
  businessId: string,
  tableId: string,
  edit?: EditStamp,
  client?: SupabaseClient
): Promise<CustomTable> {
  const db = await resolveClient(client);
  const trashed = await getCustomTable(businessId, tableId, { includeDeleted: true }, db);
  if (!trashed.deletedAt) return trashed;
  const live = await listCustomTables(businessId, db);
  if (live.length >= MAX_TABLES_PER_BUSINESS) {
    throw new CustomTableError(
      "limit",
      `You are at ${MAX_TABLES_PER_BUSINESS} tables. Delete one before restoring this.`
    );
  }
  // A same-named table may have been created while this one sat in the
  // trash. The partial unique index would refuse the restore with a raw
  // 23505, so say the useful thing instead.
  if (live.some((t) => t.name.toLowerCase() === trashed.name.toLowerCase())) {
    throw new CustomTableError(
      "duplicate",
      `You have made a new table called "${trashed.name}". Rename it before restoring this one.`
    );
  }
  const { data, error } = await db
    .from("custom_tables")
    .update({
      deleted_at: null,
      deleted_by: null,
      ...editColumns(edit),
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId)
    .eq("id", tableId)
    .select(TABLE_COLUMNS)
    .maybeSingle();
  if (error?.code === "23505") {
    throw new CustomTableError(
      "duplicate",
      `You have made a new table called "${trashed.name}". Rename it before restoring this one.`
    );
  }
  if (error) throw new Error(`restoreCustomTable: ${error.message}`);
  if (!data) throw new CustomTableError("not_found", "That table is gone.");
  return toTable(data as TableRow);
}

/**
 * Strip removed field ids out of every row of one table.
 *
 * Keyset-paged like retagContacts, and bounded by construction: rows cap at
 * MAX_ROWS_PER_TABLE, so this is at most a handful of pages. Raising that
 * cap turns this into an unbounded write storm.
 *
 * Not skippable. An orphan JSONB key is invisible retained data, which is
 * exactly what the privacy contract is about; projectRowValues hides one on
 * read, but hiding is not deleting.
 */
export async function sweepRemovedFields(
  tableId: string,
  fieldIds: readonly string[],
  client?: SupabaseClient
): Promise<number> {
  if (fieldIds.length === 0) return 0;
  const db = await resolveClient(client);
  let swept = 0;
  let afterId: string | null = null;
  for (;;) {
    let query = db
      .from("custom_table_rows")
      .select("id, field_values")
      .eq("table_id", tableId)
      .order("id", { ascending: true })
      .limit(FIELD_SWEEP_PAGE_SIZE);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) throw new Error(`sweepRemovedFields: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string; field_values: Record<string, unknown> | null }>;
    for (const row of rows) {
      const values = row.field_values ?? {};
      if (!fieldIds.some((id) => id in values)) continue;
      const next = { ...values };
      for (const id of fieldIds) delete next[id];
      // No edit stamp: a column removal is already snapshotted on the table,
      // and stamping every row would bury that one real edit under a page
      // of row_updated noise saying the same thing.
      const { error: updErr } = await db
        .from("custom_table_rows")
        .update({ field_values: next, updated_at: new Date().toISOString() })
        .eq("id", row.id);
      if (updErr) throw new Error(`sweepRemovedFields: update: ${updErr.message}`);
      swept += 1;
    }
    if (rows.length < FIELD_SWEEP_PAGE_SIZE) return swept;
    afterId = rows[rows.length - 1]!.id;
  }
}

/** Hard-delete tables whose restore window has passed. Rows cascade. */
export async function purgeExpiredCustomTables(
  now: Date = new Date(),
  client?: SupabaseClient
): Promise<number> {
  const db = await resolveClient(client);
  const cutoff = new Date(
    now.getTime() - CUSTOM_TABLE_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data, error } = await db
    .from("custom_tables")
    .delete()
    .not("deleted_at", "is", null)
    .lt("deleted_at", cutoff)
    .select("id");
  if (error) throw new Error(`purgeExpiredCustomTables: ${error.message}`);
  return (data ?? []).length;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export async function countCustomTableRows(
  tableId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = await resolveClient(client);
  const { count, error } = await db
    .from("custom_table_rows")
    .select("id", { count: "exact", head: true })
    .eq("table_id", tableId);
  if (error) throw new Error(`countCustomTableRows: ${error.message}`);
  return count ?? 0;
}

/**
 * The keyset cursor: both halves of the sort key, not just the timestamp.
 *
 * Rows are ordered by (created_at desc, id desc), and a bulk insert gives
 * every row the same `now()`. A cursor of created_at alone would then either
 * skip the rest of that timestamp's rows (with `lt`) or repeat them (with
 * `lte`), so the id has to ride along.
 */
function encodeRowCursor(row: RowRow): string {
  return `${row.created_at}|${row.id}`;
}

function decodeRowCursor(cursor: string): { createdAt: string; id: string } | null {
  const at = cursor.lastIndexOf("|");
  if (at <= 0 || at === cursor.length - 1) return null;
  return { createdAt: cursor.slice(0, at), id: cursor.slice(at + 1) };
}

/**
 * One page of rows, keyset on created_at + id.
 *
 * Paged rather than un-limited because PostgREST silently truncates an
 * un-limited select at 1000 rows, and a silently short table is worse than
 * a paged one.
 */
export async function listCustomTableRows(
  tableId: string,
  fields: readonly CustomTableField[],
  options: { limit?: number; cursor?: string | null; contactId?: string } = {},
  client?: SupabaseClient
): Promise<{ rows: CustomTableRow[]; nextCursor: string | null }> {
  const db = await resolveClient(client);
  const limit = options.limit ?? CUSTOM_TABLE_ROWS_PAGE_SIZE;
  let query = db
    .from("custom_table_rows")
    .select(ROW_COLUMNS)
    .eq("table_id", tableId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (options.contactId) query = query.eq("contact_id", options.contactId);
  const after = options.cursor ? decodeRowCursor(options.cursor) : null;
  if (after) {
    // Strictly after the cursor in (created_at desc, id desc) order: an
    // older timestamp, or the same timestamp with a lower id.
    //
    // Values are double-quoted because `.` and `:` are reserved inside an
    // `or()` filter string and a timestamp is full of both. Unquoted parses
    // correctly on the PostgREST we run today (checked against the real
    // stack, both forms return the same rows), so quoting is belt and
    // braces against a future version tightening the grammar rather than a
    // fix for something observed. Neither a timestamp nor a uuid can contain
    // a quote or a comma, so there is nothing here to escape.
    const ts = `"${after.createdAt}"`;
    query = query.or(`created_at.lt.${ts},and(created_at.eq.${ts},id.lt."${after.id}")`);
  }
  const { data, error } = await query;
  if (error) throw new Error(`listCustomTableRows: ${error.message}`);
  const raw = (data ?? []) as RowRow[];
  const page = raw.slice(0, limit);
  // We asked for limit + 1. Getting more than `limit` back therefore means
  // the page is full, so its last entry exists and carries the next cursor.
  return {
    rows: page.map((r) => toRow(r, fields)),
    nextCursor: raw.length > limit ? encodeRowCursor(page[page.length - 1]!) : null
  };
}

/** Rows joined to the contact they point at, for the grid's Contact column. */
export async function listCustomTableRowsWithContacts(
  businessId: string,
  tableId: string,
  fields: readonly CustomTableField[],
  options: { limit?: number; cursor?: string | null; contactId?: string } = {},
  client?: SupabaseClient
): Promise<{ rows: CustomTableRowWithContact[]; nextCursor: string | null }> {
  const db = await resolveClient(client);
  const page = await listCustomTableRows(tableId, fields, options, db);
  const contactIds = [...new Set(page.rows.map((r) => r.contactId).filter((id): id is string => !!id))];
  const names = new Map<string, { name: string | null; e164: string | null }>();
  if (contactIds.length > 0) {
    const { data, error } = await db
      .from("contacts")
      .select("id, display_name, customer_e164")
      .eq("business_id", businessId)
      .in("id", contactIds);
    if (error) throw new Error(`listCustomTableRowsWithContacts: ${error.message}`);
    for (const row of (data ?? []) as Array<{
      id: string;
      display_name: string | null;
      customer_e164: string | null;
    }>) {
      names.set(row.id, { name: row.display_name, e164: row.customer_e164 });
    }
  }
  return {
    rows: page.rows.map((row) => ({
      ...row,
      contactName: row.contactId ? (names.get(row.contactId)?.name ?? null) : null,
      contactE164: row.contactId ? (names.get(row.contactId)?.e164 ?? null) : null
    })),
    nextCursor: page.nextCursor
  };
}

/** Every custom row about one contact, for the contact profile panel. */
export async function listCustomTableRowsForContact(
  businessId: string,
  contactId: string,
  client?: SupabaseClient
): Promise<Array<{ table: CustomTable; rows: CustomTableRow[] }>> {
  const db = await resolveClient(client);
  const tables = (await listCustomTables(businessId, db)).filter((t) => t.rowLink === "contact");
  if (tables.length === 0) return [];
  const { data, error } = await db
    .from("custom_table_rows")
    .select(ROW_COLUMNS)
    .eq("business_id", businessId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(MAX_TABLES_PER_BUSINESS * CUSTOM_TABLE_ROWS_PAGE_SIZE);
  if (error) throw new Error(`listCustomTableRowsForContact: ${error.message}`);
  const rows = (data ?? []) as RowRow[];
  return tables
    .map((table) => ({
      table,
      rows: rows.filter((r) => r.table_id === table.id).map((r) => toRow(r, table.fields))
    }))
    .filter((entry) => entry.rows.length > 0);
}

export async function getCustomTableRow(
  tableId: string,
  rowId: string,
  fields: readonly CustomTableField[],
  client?: SupabaseClient
): Promise<CustomTableRow> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("custom_table_rows")
    .select(ROW_COLUMNS)
    .eq("table_id", tableId)
    .eq("id", rowId)
    .maybeSingle();
  if (error) throw new Error(`getCustomTableRow: ${error.message}`);
  if (!data) throw new CustomTableError("not_found", "That row is gone.");
  return toRow(data as RowRow, fields);
}

export async function createCustomTableRow(
  businessId: string,
  table: CustomTable,
  input: {
    values: Record<string, CustomTableFieldValue>;
    contactId?: string | null;
    createdBy?: string | null;
  },
  edit?: EditStamp,
  client?: SupabaseClient
): Promise<CustomTableRow> {
  const db = await resolveClient(client);
  const existing = await countCustomTableRows(table.id, db);
  if (existing >= MAX_ROWS_PER_TABLE) {
    throw new CustomTableError(
      "limit",
      `"${table.name}" is at ${MAX_ROWS_PER_TABLE} rows, which is the most a table can hold.`
    );
  }
  const { data, error } = await db
    .from("custom_table_rows")
    .insert({
      business_id: businessId,
      table_id: table.id,
      contact_id: input.contactId ?? null,
      field_values: input.values,
      created_by: input.createdBy ?? null,
      ...editColumns(edit)
    })
    .select(ROW_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`createCustomTableRow: ${error.message}`);
  if (!data) throw new CustomTableError("invalid", "The row was not created.");
  return toRow(data as RowRow, table.fields);
}

/**
 * Change some cells.
 *
 * MERGE by default, so the grid can save one cell on blur and the coworker
 * can set one column without blanking the rest. Three knobs make that safe:
 *
 * - `clear` names cells the writer explicitly sent as empty. Empty values
 *   are never stored, so without this a merge could add and change cells but
 *   never clear one.
 * - `replace` swaps the whole bag instead of merging. Restoring an old
 *   snapshot needs this: a merge could never take back a cell that was
 *   filled in AFTER the snapshot, so undo would silently leave it behind.
 */
export async function updateCustomTableRow(
  table: CustomTable,
  rowId: string,
  patch: {
    values?: Record<string, CustomTableFieldValue>;
    clear?: readonly string[];
    replace?: boolean;
    contactId?: string | null;
  },
  edit?: EditStamp,
  client?: SupabaseClient
): Promise<CustomTableRow> {
  const db = await resolveClient(client);
  const current = await getCustomTableRow(table.id, rowId, table.fields, db);
  const update: Record<string, unknown> = {
    ...editColumns(edit),
    updated_at: new Date().toISOString()
  };
  // `clear` stands on its own: emptying a cell is a change even when no
  // other cell is being set, and gating it behind `values` would make a
  // clear-only patch a silent no-op.
  if (patch.values || patch.clear?.length) {
    const supplied = patch.values ?? {};
    const next = patch.replace ? { ...supplied } : { ...current.values, ...supplied };
    for (const id of patch.clear ?? []) delete next[id];
    update.field_values = next;
  }
  if (patch.contactId !== undefined) update.contact_id = patch.contactId;
  const { data, error } = await db
    .from("custom_table_rows")
    .update(update)
    .eq("table_id", table.id)
    .eq("id", rowId)
    .select(ROW_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`updateCustomTableRow: ${error.message}`);
  if (!data) throw new CustomTableError("not_found", "That row is gone.");
  return toRow(data as RowRow, table.fields);
}

/**
 * Delete one row.
 *
 * Attribution here works BACKWARDS compared to every other call, and the
 * reason is worth stating so nobody "fixes" it back:
 *
 * A BEFORE DELETE trigger has no NEW row, so it can only read a carrier off
 * the row being deleted. Stamping the row in its own UPDATE first does not
 * work, because that UPDATE fires the update trigger, whose whole job is to
 * CONSUME the carrier and null it. The stamp is therefore always gone by the
 * time the delete runs, and every deletion lands unattributed. Verified
 * against a real Postgres, not reasoned about.
 *
 * So the snapshot stays the trigger's job and the LABEL becomes ours: delete
 * first, then name the version row the trigger just wrote. That keeps the
 * load-bearing half (the old values) out of the writer's hands, which is the
 * entire point of using a trigger, and puts only the label at risk. A failed
 * labelling is logged and swallowed: an unattributed history row is a small
 * loss, and a delete that appears to fail after the row is already gone is a
 * bigger one.
 */
export async function deleteCustomTableRow(
  tableId: string,
  rowId: string,
  edit?: EditStamp,
  client?: SupabaseClient
): Promise<void> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("custom_table_rows")
    .delete()
    .eq("table_id", tableId)
    .eq("id", rowId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`deleteCustomTableRow: ${error.message}`);
  if (!data) throw new CustomTableError("not_found", "That row is gone.");
  if (!edit?.source) return;
  const { error: labelErr } = await db
    .from("custom_table_versions")
    .update({ source: edit.source, actor: edit.actor ?? null })
    .eq("table_id", tableId)
    .eq("row_id", rowId)
    .eq("kind", "row_deleted")
    .is("source", null);
  if (labelErr) {
    logger.warn("deleteCustomTableRow: could not label the history row", {
      tableId,
      rowId,
      error: labelErr.message
    });
  }
}

/**
 * Delete every custom row belonging to one contact, when that contact is
 * deleted.
 *
 * The FK is ON DELETE SET NULL as a safety net, but silently turning a
 * deleted person's policy record into an UNLINKED row sitting in the
 * "Policies" table would leak their data into a list the owner reads as
 * "everyone else". That is exactly the reasoning behind
 * deleteContactLinkedDocuments and deleteNotesForContact, and this is the
 * third member of that set.
 *
 * The history needs the same treatment, and it is easy to miss: deleting a
 * row fires the snapshot trigger, which writes the deleted values into
 * custom_table_versions. Without the second delete here, erasing a person
 * would COPY their data into the history table rather than remove it.
 * Returns how many rows went, so the caller can log it.
 */
export async function deleteCustomTableRowsForContact(
  businessId: string,
  contactId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("custom_table_rows")
    .delete()
    .eq("business_id", businessId)
    .eq("contact_id", contactId)
    .select("id");
  if (error) throw new Error(`deleteCustomTableRowsForContact: ${error.message}`);
  const rowIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (rowIds.length === 0) return 0;
  const { error: histErr } = await db
    .from("custom_table_versions")
    .delete()
    .eq("business_id", businessId)
    .in("row_id", rowIds);
  if (histErr) throw new Error(`deleteCustomTableRowsForContact: history: ${histErr.message}`);
  return rowIds.length;
}

/** Row counts for every table in one query, for the directory and the digest. */
export async function countRowsByTable(
  businessId: string,
  client?: SupabaseClient
): Promise<Map<string, number>> {
  const db = await resolveClient(client);
  const counts = new Map<string, number>();
  let afterId: string | null = null;
  for (;;) {
    let query = db
      .from("custom_table_rows")
      .select("id, table_id")
      .eq("business_id", businessId)
      .order("id", { ascending: true })
      .limit(FIELD_SWEEP_PAGE_SIZE);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) throw new Error(`countRowsByTable: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string; table_id: string }>;
    for (const row of rows) counts.set(row.table_id, (counts.get(row.table_id) ?? 0) + 1);
    if (rows.length < FIELD_SWEEP_PAGE_SIZE) return counts;
    afterId = rows[rows.length - 1]!.id;
  }
}
