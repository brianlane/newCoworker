/**
 * Shapes and caps for owner-defined custom tables ("Tables").
 *
 * Types-only module (no Supabase import) so client components can import
 * the shapes without pulling server-only code, same rule as
 * src/lib/pipelines/types.ts.
 *
 * The vocabulary deliberately echoes the booking-page intake questions
 * (src/lib/booking-page/intake.ts): owners already meet `choice` / `multi` /
 * `text` / `textarea` there, and there is no reason to maintain a second
 * field grammar. The names differ where the surface differs (a spreadsheet
 * column says "select", a form says "choice"), but the storage rules and the
 * two-tier validation contract are the same.
 */

/**
 * Column types, and why each one is in v1.
 *
 * Deliberately NOT here, so scope creep has to argue with a written note:
 * - `contact`: the per-table `rowLink` switch already gives contact linkage
 *   as a real foreign key with ON DELETE SET NULL and indexes the privacy
 *   sweep can see. A contact id buried in field_values would be a dangling
 *   reference no cascade cleans up. One way to point at a person.
 * - `money`: deals stores integer cents specifically so nothing does float
 *   money math. A generic owner column doing float money is a correctness
 *   trap; point owners at Deals until there is a cents-backed type.
 * - `email` / `phone` / `url`: each is `text` plus a regex and a render
 *   hint. Display polish, not capability, and every one multiplies the
 *   validation branches that all need coverage.
 * - `datetime`, formulas, rollups, relations between custom tables, saved
 *   views: each a reasonable Airtable ask, none a v1 ask.
 */
export const CUSTOM_TABLE_FIELD_TYPES = [
  /** The irreducible default. */
  "text",
  /** Renders as a textarea; without it owners jam paragraphs into `text`. */
  "long_text",
  /** JSONB stores numerics natively, which is the win over text-everything. */
  "number",
  /** Date only. Removes the timezone problem from an owner-defined column. */
  "date",
  /** "Signed?", "Paid?": the type owners reach for constantly. */
  "checkbox",
  /** How a table becomes a status board, and what makes AI writes safe. */
  "select",
  /** Contact tags already taught owners this shape. */
  "multi_select"
] as const;

export type CustomTableFieldType = (typeof CUSTOM_TABLE_FIELD_TYPES)[number];

/** One owner-defined column. */
export type CustomTableField = {
  /**
   * Opaque slug generated from the label at creation, NEVER the label
   * itself. Rows key on this, so renaming a column is a one-row write
   * instead of a rewrite of every row (the trap
   * business_documents.record_fields sits in, keyed by human name).
   */
  id: string;
  label: string;
  /** Short helper line under the label in the schema editor. */
  help?: string;
  /** Immutable after creation: changing it would mean migrating every row. */
  type: CustomTableFieldType;
  /** For select / multi_select. */
  options?: string[];
  required: boolean;
  /**
   * Paused columns stay defined but are not shown or asked for. Absent on
   * rows stored before the flag existed, which reads as enabled.
   */
  enabled: boolean;
};

/** What a row is about: nothing in particular, or one contact. */
export type CustomTableRowLink = "standalone" | "contact";

export const CUSTOM_TABLE_ROW_LINKS: readonly CustomTableRowLink[] = [
  "standalone",
  "contact"
];

/** Everything a cell can hold. Never null: an empty cell has no key at all. */
export type CustomTableFieldValue = string | number | boolean | string[];

export type CustomTable = {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  icon: CustomTableIcon;
  rowLink: CustomTableRowLink;
  /** Ordered left to right, exactly as stored. */
  fields: CustomTableField[];
  position: number;
  /** Set while the table is in the trash and restorable. */
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CustomTableRow = {
  id: string;
  tableId: string;
  /** Null on a standalone table, and on a contact-linked row whose person was deleted. */
  contactId: string | null;
  values: Record<string, CustomTableFieldValue>;
  createdAt: string;
  updatedAt: string;
};

/** A row joined to the contact it points at, for the grid's Contact cell. */
export type CustomTableRowWithContact = CustomTableRow & {
  contactName: string | null;
  contactE164: string | null;
};

/**
 * Small named icon set for the directory cards, validated on every write the
 * way normalizeStageColor clamps a stage's colour. Keys are lucide icon
 * names the sidebar already ships.
 */
export const CUSTOM_TABLE_ICONS = [
  "table",
  "home",
  "truck",
  "wrench",
  "package",
  "shield",
  "clipboard",
  "tag"
] as const;

export type CustomTableIcon = (typeof CUSTOM_TABLE_ICONS)[number];

/** Clamp any stored or user value onto the icon set. */
export function normalizeTableIcon(raw: string | null | undefined): CustomTableIcon {
  return (CUSTOM_TABLE_ICONS as readonly string[]).includes(raw ?? "")
    ? (raw as CustomTableIcon)
    : "table";
}

/**
 * Caps.
 *
 * MAX_TABLES_PER_BUSINESS matches MAX_PIPELINES_PER_BUSINESS, and
 * independently matches what GoHighLevel allows per location, which is a
 * useful second opinion on "how many is enough".
 */
export const MAX_TABLES_PER_BUSINESS = 10;

/** RECORD_FIELDS_MAX_KEYS is 20: the repo's existing number for this shape. */
export const MAX_FIELDS_PER_TABLE = 20;

/**
 * Bounds AI exposure, keeps every read paginated, and makes the
 * column-delete sweep bounded BY CONSTRUCTION (5 pages of 1000).
 *
 * These two are tied. Raising this cap turns sweepRemovedFields into an
 * unbounded write storm, so do not raise one without revisiting the other.
 */
export const MAX_ROWS_PER_TABLE = 5_000;

/** Between the 40-char contact-tag cap and the 200-char todo title. */
export const MAX_TABLE_NAME_LENGTH = 60;
export const MAX_FIELD_LABEL_LENGTH = 60;
export const MAX_TABLE_DESCRIPTION_LENGTH = 500;
export const MAX_FIELD_HELP_LENGTH = 160;

/** RECORD_FIELD_VALUE_MAX_CHARS. */
export const MAX_TEXT_VALUE_LENGTH = 500;
/** MAX_TODO_DETAILS_LENGTH. */
export const MAX_LONG_TEXT_VALUE_LENGTH = 2_000;

/** Intake caps options at 8 for a public form; a status column needs headroom. */
export const MAX_FIELD_OPTIONS = 20;
export const MAX_OPTION_LENGTH = 80;

/**
 * Defense in depth: 20 columns at their individual caps cannot compose into
 * something pathological, and a single oversized multi_select cannot either.
 */
export const MAX_SERIALIZED_ROW_BYTES = 16_000;

/** JSON numbers outside this are refused rather than silently stored. */
export const MAX_NUMBER_VALUE = 1e15;

/** How long a soft-deleted table stays restorable before the sweep hard-deletes it. */
export const CUSTOM_TABLE_TRASH_RETENTION_DAYS = 30;

/** Newest-first history entries the panel and the AI tool return. */
export const CUSTOM_TABLE_VERSION_LIST_LIMIT = 20;

/**
 * Version retention. Cell edits save on blur, so row_updated is the chatty
 * kind; without a prune the history table outgrows the data it describes.
 */
export const MAX_VERSIONS_PER_TABLE = 50;
export const CUSTOM_TABLE_VERSION_RETENTION_DAYS = 90;

/** Awareness-digest cap, the DOCUMENTS_DIGEST_MAX_CHARS analogue. */
export const CUSTOM_TABLES_DIGEST_MAX_CHARS = 2_000;

/** Field ids are generated, so this is a shape assertion, not user input. */
export const FIELD_ID_PATTERN = /^[a-z0-9_]{1,40}$/;

/** Stored date values are date-only, never a timestamp. */
export const DATE_VALUE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Route slugs that can never be a table id, so a table page cannot shadow a
 * sibling route.
 */
export const RESERVED_TABLE_SLUGS: readonly string[] = ["new"];
