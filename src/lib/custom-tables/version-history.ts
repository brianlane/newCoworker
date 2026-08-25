/**
 * What the Tables History panel shows: for each snapshot, WHAT the change
 * that replaced it actually did, in plain English.
 *
 * `custom_table_versions` rows carry the state BEFORE each change and
 * nothing about the change itself (see versions.ts), so describing one means
 * pairing it with whatever replaced it: the next-newer row of the same
 * subject, or the live state for the newest one. That off-by-one is exactly
 * the bug a component would never test, so it lives here with tests instead,
 * same as src/lib/ai-flows/version-history.ts.
 *
 * Pure: no IO, no model call. The component renders these entries verbatim.
 */
import { formatFieldValue } from "@/lib/custom-tables/core";
import type { CustomTableVersionRow } from "@/lib/custom-tables/versions";
import type { CustomTable, CustomTableField } from "@/lib/custom-tables/types";

/** One row of the History panel, newest first. */
export type CustomTableHistoryEntry = {
  /** `custom_table_versions.id`, what Restore is called with. */
  versionId: number;
  /** When this state stopped being live (ISO). */
  replacedAt: string;
  /** Who or what made the change that replaced it, in plain English. */
  by: string;
  /** The stamped actor (an email or a phone), when the writer recorded one. */
  actor: string | null;
  /** Plain-English lines describing the change that replaced this snapshot. */
  changeSummary: string[];
  /** True when restoring this undoes the most recent change of its kind. */
  isMostRecent: boolean;
  /** False when the snapshot cannot be put back, so the panel hides Restore. */
  restorable: boolean;
};

/**
 * Plain-English provenance for an `edit_source` stamp.
 *
 * An unstamped row is the common case for anything written straight through
 * PostgREST, and "An earlier change" is deliberately vague rather than a
 * guess: a false attribution is worse than an absent one, which is the same
 * reason the trigger nulls the carrier columns after copying them.
 */
export function describeTableEditSource(source: string | null): string {
  switch (source) {
    case "dashboard":
      return "Changed in the dashboard";
    case "dashboard_restore":
      return "Restored from history";
    case "ai_dashboard":
      return "Changed by your coworker, in dashboard chat";
    case "ai_sms":
      return "Changed by your coworker, by text";
    case "ai_slack":
      return "Changed by your coworker, in Slack";
    case "ai_email":
      return "Changed by your coworker, by email";
    case "mcp":
      return "Changed through a connected app";
    case "mcp_restore":
      return "Restored through a connected app";
    case "sweep":
      return "Cleaned up automatically";
    default:
      return "An earlier change";
  }
}

/** Column labels that differ between two definition lists. */
function diffFields(
  before: readonly CustomTableField[],
  after: readonly CustomTableField[]
): string[] {
  const lines: string[] = [];
  const beforeIds = new Set(before.map((f) => f.id));
  const afterIds = new Set(after.map((f) => f.id));
  const added = after.filter((f) => !beforeIds.has(f.id)).map((f) => f.label);
  const removed = before.filter((f) => !afterIds.has(f.id)).map((f) => f.label);
  if (added.length > 0) lines.push(`Added the ${added.join(", ")} column${added.length > 1 ? "s" : ""}`);
  if (removed.length > 0) {
    lines.push(`Deleted the ${removed.join(", ")} column${removed.length > 1 ? "s" : ""}`);
  }
  for (const field of after) {
    const was = before.find((f) => f.id === field.id);
    if (!was) continue;
    if (was.label !== field.label) lines.push(`Renamed "${was.label}" to "${field.label}"`);
    if (was.required !== field.required) {
      lines.push(`${field.label} is ${field.required ? "now required" : "no longer required"}`);
    }
    if (was.enabled !== field.enabled) {
      lines.push(`${field.label} was ${field.enabled ? "switched back on" : "paused"}`);
    }
    const wasOptions = (was.options ?? []).join(", ");
    const nowOptions = (field.options ?? []).join(", ");
    if (wasOptions !== nowOptions) lines.push(`${field.label} options are now: ${nowOptions}`);
  }
  const beforeOrder = before.filter((f) => afterIds.has(f.id)).map((f) => f.id).join(",");
  const afterOrder = after.filter((f) => beforeIds.has(f.id)).map((f) => f.id).join(",");
  if (lines.length === 0 && beforeOrder !== afterOrder) lines.push("Reordered the columns");
  return lines;
}

/** Cell-level differences between two value bags. */
function diffValues(
  fields: readonly CustomTableField[],
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] {
  const lines: string[] = [];
  for (const field of fields) {
    const was = formatFieldValue(before[field.id] as never);
    const now = formatFieldValue(after[field.id] as never);
    if (was === now) continue;
    if (!was) lines.push(`${field.label} set to "${now}"`);
    else if (!now) lines.push(`${field.label} cleared (was "${was}")`);
    else lines.push(`${field.label}: "${was}" to "${now}"`);
  }
  return lines;
}

/**
 * Build the History panel's rows.
 *
 * `versions` must be in the order listCustomTableVersions returns (newest
 * first). `current` is the live table, which is what the newest schema
 * snapshot is compared against.
 *
 * Pairing runs per SUBJECT, not across the whole list: a row's snapshot is
 * compared with the next-newer snapshot OF THAT ROW, never with the table's
 * schema snapshot that happens to sit next to it.
 */
export function buildCustomTableHistory(
  versions: readonly CustomTableVersionRow[],
  current: Pick<CustomTable, "name" | "description" | "fields">,
  liveRowValues: ReadonlyMap<string, Record<string, unknown>> = new Map()
): CustomTableHistoryEntry[] {
  return versions.map((version, index) => {
    const newerSameSubject = versions
      .slice(0, index)
      .reverse()
      .find((v) =>
        version.rowId ? v.rowId === version.rowId : v.rowId === null && v.kind !== "row_deleted"
      );
    const isMostRecent = newerSameSubject === undefined;
    let changeSummary: string[] = [];
    let restorable = true;

    if (version.kind === "table_deleted") {
      changeSummary = ["Deleted the whole table"];
    } else if (version.kind === "table_restored") {
      changeSummary = ["Brought the table back"];
      // Restoring a "restored" snapshot would re-delete nothing useful.
      restorable = false;
    } else if (version.kind === "row_deleted") {
      changeSummary = ["Deleted a row"];
    } else if (version.kind === "schema") {
      const after = newerSameSubject
        ? {
            name: newerSameSubject.name ?? current.name,
            description: newerSameSubject.description,
            fields: newerSameSubject.fields ?? current.fields
          }
        : current;
      // `after.name` is always a string: the snapshot branch falls back to
      // the live name, and the live branch is the live table itself.
      if ((version.name ?? "") !== after.name) {
        changeSummary.push(`Renamed the table to "${after.name}"`);
      }
      if ((version.description ?? "") !== (after.description ?? "")) {
        changeSummary.push(after.description ? "Changed the description" : "Cleared the description");
      }
      changeSummary.push(...diffFields(version.fields ?? [], after.fields));
    } else {
      // row_updated: compare with the next-newer snapshot of the same row,
      // or with that row as it stands now.
      const after =
        newerSameSubject?.values ??
        (version.rowId ? liveRowValues.get(version.rowId) : undefined);
      if (after) {
        changeSummary = diffValues(current.fields, version.values ?? {}, after);
      } else {
        // The row was deleted after this edit, so there is nothing to
        // compare against. The delete has its own entry and its own restore.
        changeSummary = ["Changed a row that was deleted later"];
        restorable = false;
      }
    }

    return {
      versionId: version.id,
      replacedAt: version.replacedAt,
      by: describeTableEditSource(version.source),
      actor: version.actor,
      changeSummary,
      isMostRecent,
      restorable
    };
  });
}
