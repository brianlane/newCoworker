/**
 * Custom tables, pure domain rules. No IO, no Supabase import.
 *
 * TWO VALIDATORS, TWO TRUST LEVELS, the src/lib/booking-page/intake.ts
 * contract applied one level up:
 *
 * - `parseTableFields` normalizes what the OWNER stored. It is lenient about
 *   junk (a malformed column definition is dropped, not fatal) because a bad
 *   `fields` blob must never take the Tables page, an AI read, or the
 *   awareness digest down.
 * - `validateRowValues` checks what a WRITER submitted, strictly: unknown
 *   field ids are discarded, required columns must be answered, select
 *   values must be one of the offered options. It answers field-level errors
 *   so the grid can point at the exact cell and the coworker can relay
 *   "Status must be one of: New, Won, Lost".
 *
 * That asymmetry is what makes AI writes safe. The coworker is a SUBMITTER,
 * not an owner: it goes through the strict tier, so a model can never invent
 * a column or a status by writing one.
 */
import { z } from "zod";
import {
  CUSTOM_TABLE_FIELD_TYPES,
  CUSTOM_TABLE_ICONS,
  CUSTOM_TABLE_ROW_LINKS,
  CUSTOM_TABLES_DIGEST_MAX_CHARS,
  DATE_VALUE_PATTERN,
  FIELD_ID_PATTERN,
  MAX_FIELD_HELP_LENGTH,
  MAX_FIELD_LABEL_LENGTH,
  MAX_FIELD_OPTIONS,
  MAX_FIELDS_PER_TABLE,
  MAX_LONG_TEXT_VALUE_LENGTH,
  MAX_NUMBER_VALUE,
  MAX_OPTION_LENGTH,
  MAX_SERIALIZED_ROW_BYTES,
  MAX_TABLE_DESCRIPTION_LENGTH,
  MAX_TABLE_NAME_LENGTH,
  MAX_TEXT_VALUE_LENGTH,
  RESERVED_TABLE_SLUGS,
  type CustomTable,
  type CustomTableField,
  type CustomTableFieldType,
  type CustomTableFieldValue,
  type CustomTableRow
} from "@/lib/custom-tables/types";

// ---------------------------------------------------------------------------
// Field ids
// ---------------------------------------------------------------------------

/**
 * "Renewal date" -> "renewal_date", uniquified against ids already taken.
 *
 * A label of pure punctuation still has to produce something addressable, so
 * it falls back to a positional name rather than returning "" and failing
 * the id pattern.
 */
export function slugifyFieldId(label: string, taken: readonly string[] = []): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 36) || `field_${taken.length + 1}`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base.slice(0, 36 - String(n).length - 1)}_${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Tier one: lenient, for owner-stored definitions
// ---------------------------------------------------------------------------

function cleanOptions(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((o): o is string => typeof o === "string")
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && o.length <= MAX_OPTION_LENGTH)
    .filter((o, i, all) => all.indexOf(o) === i)
    .slice(0, MAX_FIELD_OPTIONS);
}

/** True for the two types whose values must come from a closed list. */
export function fieldHasOptions(type: CustomTableFieldType): boolean {
  return type === "select" || type === "multi_select";
}

/**
 * Normalize the stored `fields` column. Junk entries are dropped rather than
 * thrown: definition rot must never take the page down.
 */
export function parseTableFields(raw: unknown): CustomTableField[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const fields: CustomTableField[] = [];
  for (const entry of raw) {
    if (fields.length >= MAX_FIELDS_PER_TABLE) break;
    if (typeof entry !== "object" || entry === null) continue;
    const f = entry as Record<string, unknown>;
    const id = typeof f.id === "string" ? f.id : "";
    const label = typeof f.label === "string" ? f.label.trim() : "";
    const type = f.type as CustomTableFieldType;
    if (!FIELD_ID_PATTERN.test(id) || seen.has(id)) continue;
    if (!label || label.length > MAX_FIELD_LABEL_LENGTH) continue;
    if (!CUSTOM_TABLE_FIELD_TYPES.includes(type)) continue;

    let options: string[] | undefined;
    if (fieldHasOptions(type)) {
      options = cleanOptions(f.options);
      // A select with fewer than two choices is not a choice. Dropping it
      // keeps the cell from rendering a dropdown nobody can use.
      if (options.length < 2) continue;
    }

    const help = typeof f.help === "string" ? f.help.trim().slice(0, MAX_FIELD_HELP_LENGTH) : "";
    seen.add(id);
    fields.push({
      id,
      label,
      ...(help ? { help } : {}),
      type,
      ...(options ? { options } : {}),
      required: f.required === true,
      // Absent reads as enabled, so definitions stored before the flag
      // existed keep working.
      enabled: f.enabled !== false
    });
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Tier two: strict, for submitted values
// ---------------------------------------------------------------------------

/** Why one cell was refused. The grid maps these to copy; the AI relays them. */
export type RowValueErrorCode =
  | "required"
  | "wrong_type"
  | "too_long"
  | "out_of_range"
  | "bad_date"
  | "not_an_option"
  | "row_too_large";

export type RowValueError = { fieldId: string; code: RowValueErrorCode };

export type ValidateRowResult =
  | { ok: true; values: Record<string, CustomTableFieldValue> }
  | { ok: false; errors: RowValueError[] };

function validateOne(
  field: CustomTableField,
  raw: unknown
): { ok: true; value: CustomTableFieldValue } | { ok: false; code: RowValueErrorCode } {
  switch (field.type) {
    case "text":
    case "long_text": {
      if (typeof raw !== "string") return { ok: false, code: "wrong_type" };
      const max = field.type === "text" ? MAX_TEXT_VALUE_LENGTH : MAX_LONG_TEXT_VALUE_LENGTH;
      const trimmed = raw.trim();
      if (trimmed.length > max) return { ok: false, code: "too_long" };
      return { ok: true, value: trimmed };
    }
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { ok: false, code: "wrong_type" };
      }
      if (Math.abs(raw) > MAX_NUMBER_VALUE) return { ok: false, code: "out_of_range" };
      return { ok: true, value: raw };
    }
    case "date": {
      if (typeof raw !== "string") return { ok: false, code: "wrong_type" };
      const trimmed = raw.trim();
      if (!DATE_VALUE_PATTERN.test(trimmed)) return { ok: false, code: "bad_date" };
      // Round-tripping catches "2026-02-31", which the pattern happily allows.
      const parsed = new Date(`${trimmed}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(trimmed)) {
        return { ok: false, code: "bad_date" };
      }
      return { ok: true, value: trimmed };
    }
    case "checkbox": {
      if (typeof raw !== "boolean") return { ok: false, code: "wrong_type" };
      return { ok: true, value: raw };
    }
    case "select": {
      if (typeof raw !== "string") return { ok: false, code: "wrong_type" };
      const trimmed = raw.trim();
      const match = (field.options ?? []).find(
        (o) => o.toLowerCase() === trimmed.toLowerCase()
      );
      if (!match) return { ok: false, code: "not_an_option" };
      // Answer the OWNER's casing, not the writer's, so a model typing
      // "won" files under "Won" rather than creating a lookalike.
      return { ok: true, value: match };
    }
    case "multi_select": {
      if (!Array.isArray(raw)) return { ok: false, code: "wrong_type" };
      if (raw.some((v) => typeof v !== "string")) return { ok: false, code: "wrong_type" };
      const chosen: string[] = [];
      for (const entry of raw as string[]) {
        const match = (field.options ?? []).find(
          (o) => o.toLowerCase() === entry.trim().toLowerCase()
        );
        if (!match) return { ok: false, code: "not_an_option" };
        if (!chosen.includes(match)) chosen.push(match);
      }
      return { ok: true, value: chosen };
    }
  }
}

/** True when a value counts as "not filled in". */
function isEmptyValue(raw: unknown): boolean {
  return (
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && raw.trim() === "") ||
    (Array.isArray(raw) && raw.length === 0)
  );
}

/**
 * Validate a submitted value bag against the table's columns.
 *
 * Unknown field ids are DISCARDED rather than refused: the schema may have
 * changed under an open grid or a model's stale read, and failing the whole
 * write for a column that no longer exists helps nobody. That is
 * validateIntakeAnswers' exact reasoning.
 */
export function validateRowValues(
  fields: readonly CustomTableField[],
  raw: unknown
): ValidateRowResult {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const values: Record<string, CustomTableFieldValue> = {};
  const errors: RowValueError[] = [];

  for (const field of fields) {
    if (!field.enabled) continue;
    const supplied = input[field.id];
    if (isEmptyValue(supplied)) {
      if (field.required) errors.push({ fieldId: field.id, code: "required" });
      // Absent key means empty. Nulls are never stored.
      continue;
    }
    const checked = validateOne(field, supplied);
    if (!checked.ok) {
      errors.push({ fieldId: field.id, code: checked.code });
      continue;
    }
    values[field.id] = checked.value;
  }

  if (errors.length > 0) return { ok: false, errors };
  if (JSON.stringify(values).length > MAX_SERIALIZED_ROW_BYTES) {
    return { ok: false, errors: [{ fieldId: "", code: "row_too_large" }] };
  }
  return { ok: true, values };
}

/**
 * Turn a string into the value its column expects.
 *
 * The AI tools declare values as `{field, value}` string pairs rather than an
 * open object, because Rowboat and Gemini function-calling schemas are
 * unreliable with additionalProperties and union-typed values. Every value
 * therefore arrives as a string and lands here, which keeps all coercion in
 * one tested place.
 */
export function coerceFieldValue(
  field: CustomTableField,
  raw: string
): { ok: true; value: CustomTableFieldValue } | { ok: false; code: RowValueErrorCode } {
  const trimmed = raw.trim();
  switch (field.type) {
    case "number": {
      const n = Number(trimmed.replace(/[$,\s]/g, ""));
      if (trimmed === "" || Number.isNaN(n)) return { ok: false, code: "wrong_type" };
      return validateOne(field, n);
    }
    case "checkbox": {
      const yes = ["true", "yes", "y", "1", "on", "checked"];
      const no = ["false", "no", "n", "0", "off", "unchecked"];
      const lowered = trimmed.toLowerCase();
      if (yes.includes(lowered)) return validateOne(field, true);
      if (no.includes(lowered)) return validateOne(field, false);
      return { ok: false, code: "wrong_type" };
    }
    case "multi_select": {
      const parts = trimmed
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      return validateOne(field, parts);
    }
    default:
      return validateOne(field, trimmed);
  }
}

// ---------------------------------------------------------------------------
// Schema edits
// ---------------------------------------------------------------------------

export type FieldDefinitionPatch =
  | { action: "add"; label: string; type: CustomTableFieldType; help?: string; options?: string[]; required?: boolean }
  | { action: "update"; fieldId: string; label?: string; help?: string; options?: string[]; required?: boolean; enabled?: boolean }
  | { action: "remove"; fieldId: string }
  | { action: "reorder"; fieldIds: string[] };

export type FieldPatchResult =
  | { ok: true; fields: CustomTableField[]; removedFieldIds: string[] }
  | { ok: false; code: "limit" | "duplicate" | "invalid" | "not_found"; message: string };

/**
 * Apply one schema edit to a column list.
 *
 * A column's TYPE is deliberately not patchable. Changing it would mean
 * migrating every row's value with no transaction available, so the owner
 * deletes the column and adds a new one, which makes the data loss explicit
 * instead of silent.
 */
export function applyFieldDefinitionPatch(
  fields: readonly CustomTableField[],
  patch: FieldDefinitionPatch
): FieldPatchResult {
  const current = fields.map((f) => ({ ...f }));

  if (patch.action === "add") {
    if (current.length >= MAX_FIELDS_PER_TABLE) {
      return { ok: false, code: "limit", message: `A table can have ${MAX_FIELDS_PER_TABLE} columns.` };
    }
    const label = patch.label.trim();
    if (!label || label.length > MAX_FIELD_LABEL_LENGTH) {
      return { ok: false, code: "invalid", message: "Give the column a name." };
    }
    if (current.some((f) => f.label.toLowerCase() === label.toLowerCase())) {
      return { ok: false, code: "duplicate", message: `There is already a column called "${label}".` };
    }
    const options = fieldHasOptions(patch.type) ? cleanOptions(patch.options) : undefined;
    if (options && options.length < 2) {
      return { ok: false, code: "invalid", message: "A choice column needs at least two options." };
    }
    const help = patch.help?.trim().slice(0, MAX_FIELD_HELP_LENGTH);
    current.push({
      id: slugifyFieldId(label, current.map((f) => f.id)),
      label,
      ...(help ? { help } : {}),
      type: patch.type,
      ...(options ? { options } : {}),
      required: patch.required === true,
      enabled: true
    });
    return { ok: true, fields: current, removedFieldIds: [] };
  }

  if (patch.action === "update") {
    const target = current.find((f) => f.id === patch.fieldId);
    if (!target) return { ok: false, code: "not_found", message: "That column is gone." };
    if (patch.label !== undefined) {
      const label = patch.label.trim();
      if (!label || label.length > MAX_FIELD_LABEL_LENGTH) {
        return { ok: false, code: "invalid", message: "Give the column a name." };
      }
      if (current.some((f) => f.id !== target.id && f.label.toLowerCase() === label.toLowerCase())) {
        return { ok: false, code: "duplicate", message: `There is already a column called "${label}".` };
      }
      target.label = label;
    }
    if (patch.help !== undefined) {
      const help = patch.help.trim().slice(0, MAX_FIELD_HELP_LENGTH);
      if (help) target.help = help;
      else delete target.help;
    }
    if (patch.options !== undefined) {
      if (!fieldHasOptions(target.type)) {
        return { ok: false, code: "invalid", message: "That column does not have options." };
      }
      const options = cleanOptions(patch.options);
      if (options.length < 2) {
        return { ok: false, code: "invalid", message: "A choice column needs at least two options." };
      }
      target.options = options;
    }
    if (patch.required !== undefined) target.required = patch.required;
    if (patch.enabled !== undefined) target.enabled = patch.enabled;
    return { ok: true, fields: current, removedFieldIds: [] };
  }

  if (patch.action === "remove") {
    const next = current.filter((f) => f.id !== patch.fieldId);
    if (next.length === current.length) {
      return { ok: false, code: "not_found", message: "That column is gone." };
    }
    return { ok: true, fields: next, removedFieldIds: [patch.fieldId] };
  }

  // reorder: an exact permutation, the reorderStages rule. Anything else
  // would silently add or drop a column.
  const ids = current.map((f) => f.id);
  const wanted = patch.fieldIds;
  if (wanted.length !== ids.length || new Set(wanted).size !== wanted.length) {
    return { ok: false, code: "invalid", message: "Send every column exactly once." };
  }
  const reordered: CustomTableField[] = [];
  for (const id of wanted) {
    const found = current.find((f) => f.id === id);
    if (!found) return { ok: false, code: "invalid", message: "Send every column exactly once." };
    reordered.push(found);
  }
  return { ok: true, fields: reordered, removedFieldIds: [] };
}

/**
 * Drop stored keys no column claims any more.
 *
 * The column-delete sweep clears these at the source, but a sweep that dies
 * halfway leaves orphans behind, and an orphan JSONB key is invisible
 * retained data. Projecting on read means an orphan is never shown, never
 * exported, and never handed to a model, whatever the storage says.
 */
export function projectRowValues(
  fields: readonly CustomTableField[],
  stored: Record<string, unknown> | null | undefined
): Record<string, CustomTableFieldValue> {
  const out: Record<string, CustomTableFieldValue> = {};
  if (!stored) return out;
  for (const field of fields) {
    const value = stored[field.id];
    if (value === undefined || value === null) continue;
    out[field.id] = value as CustomTableFieldValue;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One cell as text, for CSV, search, the digest, and what a model reads back. */
export function formatFieldValue(value: CustomTableFieldValue | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/**
 * A row as one line a person and a model both read, the formatIntakeAnswers
 * analogue. Used in tool replies and in the delete confirmation, so the
 * owner hears what is about to go.
 */
export function formatRowSummary(
  fields: readonly CustomTableField[],
  row: Pick<CustomTableRow, "values">
): string {
  const parts: string[] = [];
  for (const field of fields) {
    if (!field.enabled) continue;
    const rendered = formatFieldValue(row.values[field.id]);
    if (rendered) parts.push(`${field.label}: ${rendered}`);
  }
  return parts.join(" | ");
}

/** Case-insensitive substring match across every rendered cell. */
export function matchRowsByQuery<T extends Pick<CustomTableRow, "values">>(
  fields: readonly CustomTableField[],
  rows: readonly T[],
  query: string
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) => formatRowSummary(fields, row).toLowerCase().includes(needle));
}

/**
 * Awareness digest for the owner coworker's context block, the
 * buildDocumentsDigestMd analogue.
 *
 * Names and column labels only, never row contents: the coworker reads rows
 * live through the custom_table_* tools, and a prompt copy would be both
 * enormous and stale. Returns "" when there are no tables, so the caller can
 * skip the section entirely.
 */
export function buildCustomTablesDigestMd(
  tables: readonly (Pick<CustomTable, "name" | "rowLink" | "fields"> & { rowCount: number })[],
  maxChars: number = CUSTOM_TABLES_DIGEST_MAX_CHARS
): string {
  if (tables.length === 0) return "";
  const lines: string[] = [
    "# tables.md",
    "Tables the owner keeps (read and update them with the custom_table_ tools; never guess at their contents):",
    ""
  ];
  for (const table of tables) {
    const columns = table.fields
      .filter((f) => f.enabled)
      .map((f) => f.label)
      .join(", ");
    const link = table.rowLink === "contact" ? "one row per contact" : "standalone";
    lines.push(
      `- **${table.name}** (${link}, ${table.rowCount} rows)${columns ? `: ${columns}` : ""}`
    );
  }
  return lines.join("\n").slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

/**
 * Three tiers, the resolveDocumentReference contract: id, then exact name,
 * then a UNIQUE substring. More than one match at any tier refuses as
 * ambiguous so the model asks instead of guessing.
 *
 * `exactOnly` is the read/write asymmetry that matters most here. A read
 * that lands on the wrong table shows the wrong data; a WRITE that lands on
 * the wrong table corrupts it, and a delete is worse still. So the write
 * tools pass exactOnly and refuse to accept "prop" for "Properties".
 */
export function resolveTableReference<T extends Pick<CustomTable, "id" | "name">>(
  tables: readonly T[],
  ref: string,
  exactOnly = false
): { ok: true; table: T } | { ok: false; detail: "table_not_found" | "table_ambiguous" } {
  const needle = ref.trim().toLowerCase();
  if (!needle) return { ok: false, detail: "table_not_found" };
  const byId = tables.find((t) => t.id.toLowerCase() === needle);
  if (byId) return { ok: true, table: byId };
  const exact = tables.filter((t) => t.name.trim().toLowerCase() === needle);
  if (exact.length === 1) return { ok: true, table: exact[0] };
  if (exact.length > 1) return { ok: false, detail: "table_ambiguous" };
  if (exactOnly) return { ok: false, detail: "table_not_found" };
  const partial = tables.filter((t) => t.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { ok: true, table: partial[0] };
  if (partial.length > 1) return { ok: false, detail: "table_ambiguous" };
  return { ok: false, detail: "table_not_found" };
}

/**
 * Resolve a column by the LABEL the model saw in custom_table_list, or by
 * its id. An unrecognized label is an explicit error rather than a silently
 * dropped value: silent dropping is how an AI reports saving data that is
 * not there.
 */
export function resolveFieldReference(
  fields: readonly CustomTableField[],
  ref: string
): { ok: true; field: CustomTableField } | { ok: false; detail: "field_not_found" | "field_ambiguous" } {
  const needle = ref.trim().toLowerCase();
  if (!needle) return { ok: false, detail: "field_not_found" };
  const byId = fields.find((f) => f.id === needle);
  if (byId) return { ok: true, field: byId };
  const exact = fields.filter((f) => f.label.trim().toLowerCase() === needle);
  if (exact.length === 1) return { ok: true, field: exact[0] };
  if (exact.length > 1) return { ok: false, detail: "field_ambiguous" };
  return { ok: false, detail: "field_not_found" };
}

/** Rows resolve by id, or by a unique match on their rendered summary line. */
export function resolveRowReference<T extends CustomTableRow>(
  fields: readonly CustomTableField[],
  rows: readonly T[],
  ref: string
): { ok: true; row: T } | { ok: false; detail: "row_not_found" | "row_ambiguous" } {
  const needle = ref.trim().toLowerCase();
  if (!needle) return { ok: false, detail: "row_not_found" };
  const byId = rows.find((r) => r.id.toLowerCase() === needle);
  if (byId) return { ok: true, row: byId };
  const matches = matchRowsByQuery(fields, rows, needle);
  if (matches.length === 1) return { ok: true, row: matches[0] };
  if (matches.length > 1) return { ok: false, detail: "row_ambiguous" };
  return { ok: false, detail: "row_not_found" };
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------
// Schemas live here rather than in the route, per src/lib/deals/core.ts and
// src/lib/todos/core.ts, so the 100%-covered layer owns the validation and
// the routes stay thin.

const tableNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TABLE_NAME_LENGTH)
  .refine((v) => !RESERVED_TABLE_SLUGS.includes(v.toLowerCase()), {
    message: "That name is reserved."
  });

const fieldTypeSchema = z.enum(CUSTOM_TABLE_FIELD_TYPES);

const fieldDraftSchema = z
  .object({
    label: z.string().trim().min(1).max(MAX_FIELD_LABEL_LENGTH),
    type: fieldTypeSchema,
    help: z.string().trim().max(MAX_FIELD_HELP_LENGTH).optional(),
    options: z.array(z.string().trim().max(MAX_OPTION_LENGTH)).max(MAX_FIELD_OPTIONS).optional(),
    required: z.boolean().optional()
  })
  .strict();

/** POST /api/dashboard/custom-tables */
export const tableCreateSchema = z
  .object({
    name: tableNameSchema,
    description: z.string().trim().max(MAX_TABLE_DESCRIPTION_LENGTH).optional(),
    icon: z.enum(CUSTOM_TABLE_ICONS).optional(),
    rowLink: z.enum(CUSTOM_TABLE_ROW_LINKS as [string, ...string[]]).optional(),
    fields: z.array(fieldDraftSchema).min(1).max(MAX_FIELDS_PER_TABLE)
  })
  .strict();

/** PATCH /api/dashboard/custom-tables/[tableId], a discriminated union on `action`. */
export const tablePatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("rename"), name: tableNameSchema }).strict(),
  z
    .object({
      action: z.literal("update_details"),
      description: z.string().trim().max(MAX_TABLE_DESCRIPTION_LENGTH).nullable().optional(),
      icon: z.enum(CUSTOM_TABLE_ICONS).optional()
    })
    .strict(),
  z.object({ action: z.literal("add_field"), field: fieldDraftSchema }).strict(),
  z
    .object({
      action: z.literal("update_field"),
      fieldId: z.string().trim().min(1),
      label: z.string().trim().min(1).max(MAX_FIELD_LABEL_LENGTH).optional(),
      help: z.string().trim().max(MAX_FIELD_HELP_LENGTH).optional(),
      options: z.array(z.string().trim().max(MAX_OPTION_LENGTH)).max(MAX_FIELD_OPTIONS).optional(),
      required: z.boolean().optional(),
      enabled: z.boolean().optional()
    })
    .strict(),
  z
    .object({ action: z.literal("reorder_fields"), fieldIds: z.array(z.string()).min(1) })
    .strict(),
  z.object({ action: z.literal("delete_field"), fieldId: z.string().trim().min(1) }).strict()
]);

/** Raw cell values arrive as an open bag; validateRowValues is the gate. */
const rowValuesSchema = z.record(z.string(), z.unknown());

export const rowCreateSchema = z
  .object({
    values: rowValuesSchema,
    contactId: z.string().uuid().nullable().optional()
  })
  .strict();

export const rowPatchSchema = z
  .object({
    values: rowValuesSchema.optional(),
    contactId: z.string().uuid().nullable().optional()
  })
  .strict();

export const rowListFilterSchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    contactId: z.string().uuid().optional(),
    q: z.string().trim().max(200).optional()
  })
  .strict();
