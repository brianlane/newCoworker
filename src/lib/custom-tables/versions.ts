/**
 * Reading and restoring custom-table history.
 *
 * Rows in `custom_table_versions` are written by triggers and hold the state
 * as it was BEFORE each change. Nothing in here writes a version row
 * directly, on purpose: an app-code writer is a writer that can be forgotten,
 * and the whole reason the snapshot is a trigger is that a forgetful path
 * must not be able to skip it.
 *
 * Restores go back through the normal update functions rather than writing
 * the table directly, so a restore validates like any other change and is
 * itself snapshotted. Undo is therefore undoable, and reverting the wrong
 * change is not a second unrecoverable event.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  CustomTableError,
  getCustomTable,
  patchCustomTableFields,
  restoreCustomTable,
  updateCustomTableDetails,
  updateCustomTableRow,
  createCustomTableRow,
  type EditStamp
} from "@/lib/custom-tables/db";
import { parseTableFields, projectRowValues } from "@/lib/custom-tables/core";
import {
  CUSTOM_TABLE_VERSION_LIST_LIMIT,
  CUSTOM_TABLE_VERSION_RETENTION_DAYS,
  MAX_VERSIONS_PER_TABLE,
  type CustomTableField,
  type CustomTableFieldValue
} from "@/lib/custom-tables/types";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const CUSTOM_TABLE_VERSION_KINDS = [
  "schema",
  "table_deleted",
  "table_restored",
  "row_updated",
  "row_deleted"
] as const;

export type CustomTableVersionKind = (typeof CUSTOM_TABLE_VERSION_KINDS)[number];

export type CustomTableVersionRow = {
  id: number;
  tableId: string;
  rowId: string | null;
  kind: CustomTableVersionKind;
  name: string | null;
  description: string | null;
  rowLink: string | null;
  fields: CustomTableField[] | null;
  values: Record<string, CustomTableFieldValue> | null;
  contactId: string | null;
  source: string | null;
  actor: string | null;
  replacedAt: string;
};

const VERSION_COLUMNS =
  "id, table_id, row_id, kind, name, description, row_link, fields, field_values, contact_id, source, actor, replaced_at";

type VersionDbRow = {
  id: number;
  table_id: string;
  row_id: string | null;
  kind: string;
  name: string | null;
  description: string | null;
  row_link: string | null;
  fields: unknown;
  field_values: Record<string, unknown> | null;
  contact_id: string | null;
  source: string | null;
  actor: string | null;
  replaced_at: string;
};

async function resolveClient(client?: SupabaseClient): Promise<SupabaseClient> {
  return client ?? (await createSupabaseServiceClient());
}

function toVersion(row: VersionDbRow): CustomTableVersionRow {
  const fields = row.fields === null ? null : parseTableFields(row.fields);
  return {
    id: row.id,
    tableId: row.table_id,
    rowId: row.row_id,
    kind: row.kind as CustomTableVersionKind,
    name: row.name,
    description: row.description,
    rowLink: row.row_link,
    fields,
    // Values are projected against whichever field set the snapshot carries,
    // so a column removed after the snapshot does not resurface on restore.
    values: row.field_values === null ? null : projectRowValues(fields ?? [], row.field_values),
    contactId: row.contact_id,
    source: row.source,
    actor: row.actor,
    replacedAt: row.replaced_at
  };
}

/** Newest-first history for one table, including its rows' history. */
export async function listCustomTableVersions(
  businessId: string,
  tableId: string,
  limit: number = CUSTOM_TABLE_VERSION_LIST_LIMIT,
  client?: SupabaseClient
): Promise<CustomTableVersionRow[]> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("custom_table_versions")
    .select(VERSION_COLUMNS)
    .eq("business_id", businessId)
    .eq("table_id", tableId)
    .order("replaced_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listCustomTableVersions: ${error.message}`);
  return ((data ?? []) as VersionDbRow[]).map(toVersion);
}

/** Newest-first history across every table, for "what changed last night?". */
export async function listBusinessCustomTableVersions(
  businessId: string,
  limit: number = CUSTOM_TABLE_VERSION_LIST_LIMIT,
  client?: SupabaseClient
): Promise<CustomTableVersionRow[]> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("custom_table_versions")
    .select(VERSION_COLUMNS)
    .eq("business_id", businessId)
    .order("replaced_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listBusinessCustomTableVersions: ${error.message}`);
  return ((data ?? []) as VersionDbRow[]).map(toVersion);
}

export async function getCustomTableVersion(
  businessId: string,
  versionId: number,
  client?: SupabaseClient
): Promise<CustomTableVersionRow> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("custom_table_versions")
    .select(VERSION_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", versionId)
    .maybeSingle();
  if (error) throw new Error(`getCustomTableVersion: ${error.message}`);
  if (!data) throw new CustomTableError("not_found", "That change is no longer in the history.");
  return toVersion(data as VersionDbRow);
}

export type RestoreOutcome =
  | { kind: "schema" }
  | { kind: "table_restored" }
  | { kind: "row_updated"; rowId: string }
  | { kind: "row_recreated"; rowId: string };

/**
 * Put one snapshot back.
 *
 * Every branch routes through the normal update path, so the restore is
 * validated and snapshotted like any other change.
 */
export async function restoreCustomTableVersion(
  businessId: string,
  versionId: number,
  edit: EditStamp,
  client?: SupabaseClient
): Promise<RestoreOutcome> {
  const db = await resolveClient(client);
  const version = await getCustomTableVersion(businessId, versionId, db);

  if (version.kind === "table_deleted") {
    await restoreCustomTable(businessId, version.tableId, edit, db);
    return { kind: "table_restored" };
  }

  if (version.kind === "schema" || version.kind === "table_restored") {
    // The name and description go back through the details path, and the
    // columns through the field path, so both get their normal validation.
    await updateCustomTableDetails(
      businessId,
      version.tableId,
      { name: version.name ?? undefined, description: version.description },
      edit,
      db
    );
    const table = await getCustomTable(businessId, version.tableId, {}, db);
    const wanted = version.fields ?? [];
    // Reordering is expressible as a patch; adding a column back is not, so
    // a restore that would resurrect a deleted column reorders what remains
    // and says nothing about the rest. Deleting a column already swept its
    // data, so bringing the definition back would bring back an empty
    // column pretending to be the old one.
    const shared = wanted.map((f) => f.id).filter((id) => table.fields.some((f) => f.id === id));
    const liveOrder = table.fields.map((f) => f.id).join(",");
    // Only when the snapshot still accounts for every live column AND the
    // order genuinely differs. Writing an identical order back would be a
    // wasted round trip that says "changed" in the history for nothing.
    if (shared.length === table.fields.length && shared.join(",") !== liveOrder) {
      await patchCustomTableFields(
        businessId,
        version.tableId,
        { action: "reorder", fieldIds: shared },
        edit,
        db
      );
    }
    return { kind: "schema" };
  }

  const table = await getCustomTable(businessId, version.tableId, {}, db);
  const values = version.values ?? {};

  if (version.kind === "row_updated" && version.rowId) {
    await updateCustomTableRow(
      table,
      version.rowId,
      { values, contactId: version.contactId },
      edit,
      db
    );
    return { kind: "row_updated", rowId: version.rowId };
  }

  // row_deleted: the row is gone, so restoring means recreating it. It comes
  // back with a NEW id, which is honest: anything that referenced the old id
  // referenced a row that no longer exists.
  const recreated = await createCustomTableRow(
    businessId,
    table,
    { values, contactId: version.contactId },
    edit,
    db
  );
  return { kind: "row_recreated", rowId: recreated.id };
}

/**
 * Prune history so it cannot outgrow the data it describes.
 *
 * Cell edits save on blur, so `row_updated` is the chatty kind. Two bounds,
 * both needed: anything past the retention window goes, and a table that
 * churns inside the window keeps only its newest MAX_VERSIONS_PER_TABLE.
 */
export async function pruneCustomTableVersions(
  tableId: string,
  now: Date = new Date(),
  client?: SupabaseClient
): Promise<number> {
  const db = await resolveClient(client);
  const cutoff = new Date(
    now.getTime() - CUSTOM_TABLE_VERSION_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data: aged, error: agedErr } = await db
    .from("custom_table_versions")
    .delete()
    .eq("table_id", tableId)
    .lt("replaced_at", cutoff)
    .select("id");
  if (agedErr) throw new Error(`pruneCustomTableVersions: ${agedErr.message}`);
  let pruned = (aged ?? []).length;

  const { data: kept, error: keptErr } = await db
    .from("custom_table_versions")
    .select("id")
    .eq("table_id", tableId)
    .order("replaced_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(MAX_VERSIONS_PER_TABLE + 1);
  if (keptErr) throw new Error(`pruneCustomTableVersions: ${keptErr.message}`);
  const ids = ((kept ?? []) as Array<{ id: number }>).map((r) => r.id);
  if (ids.length <= MAX_VERSIONS_PER_TABLE) return pruned;

  const oldestKept = ids[MAX_VERSIONS_PER_TABLE - 1]!;
  const { data: trimmed, error: trimErr } = await db
    .from("custom_table_versions")
    .delete()
    .eq("table_id", tableId)
    .lt("id", oldestKept)
    .select("id");
  if (trimErr) throw new Error(`pruneCustomTableVersions: ${trimErr.message}`);
  pruned += (trimmed ?? []).length;
  return pruned;
}
