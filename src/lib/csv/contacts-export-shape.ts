/**
 * The contacts CSV column contract, plus the client-side "export selected"
 * builder for the customers page multi-select.
 *
 * The headers live here, apart from src/lib/csv/contacts.ts, because that
 * module is server-only (it imports the Supabase service client) while the
 * selected-rows export runs in the BROWSER from rows the page already
 * loaded. One column list for both exports, so a selected export opens next
 * to a full export with no surprises, and a re-import maps cleanly: the
 * importer treats a blank cell as "leave as is", so the columns the list
 * view does not carry (email, reply mode, pinned notes, aliases) are simply
 * left empty here.
 */

import { serializeCsv } from "./csv";

export const CONTACTS_EXPORT_HEADERS = [
  "phone",
  "name",
  "type",
  "email",
  "sms_reply_mode",
  "pinned_notes",
  "tags",
  "aliases",
  "last_channel",
  "last_interaction_at",
  "total_interactions",
  "created_at"
] as const;

/** The slice of a loaded customers-list row the selected export can carry. */
export type SelectedContactExportRow = {
  /** The contact KEY (E.164, short code, or `email:` key), as the full export writes it. */
  e164: string;
  /** Human-readable form of the key (the bare address for email-keyed contacts). */
  label: string;
  /** The RESOLVED display name the list shows (owner/employee overlays included). */
  name: string;
  type: string;
  tags: string[];
  lastChannel: string | null;
  lastInteractionAt: string | null;
  totalInteractions: number;
  createdAt: string;
};

/**
 * CSV text for the selected rows, in the full export's column order.
 *
 * The name cell carries the RESOLVED name the list shows (that is what the
 * owner selected and what an external tool needs), except when the row has
 * no name at all and the list fell back to showing the key itself: then the
 * cell stays blank rather than duplicating the phone column.
 *
 * The type cell is different: the list's `type` may be the owner/employee
 * IDENTITY overlay resolved at read time from the roster, not the stored
 * classification, and the importer writes any non-blank type cell into the
 * stored column. Exporting the overlay would let a re-import freeze
 * "owner"/"employee" into data that outlives the roster, so those two
 * values export as a blank cell (blank means "leave as is" on import) and
 * the stored classifications pass through.
 */
export function selectedContactsCsv(rows: SelectedContactExportRow[]): string {
  return serializeCsv([
    [...CONTACTS_EXPORT_HEADERS],
    ...rows.map((r) => [
      r.e164,
      r.name === r.label ? "" : r.name,
      r.type === "owner" || r.type === "employee" ? "" : r.type,
      "",
      "",
      "",
      r.tags.join(", "),
      "",
      r.lastChannel ?? "",
      r.lastInteractionAt ?? "",
      r.totalInteractions,
      r.createdAt
    ])
  ]);
}
