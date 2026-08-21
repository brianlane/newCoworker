/**
 * Pure Follow Up Boss CSV -> New Coworker mapping.
 *
 * Everything here is a plain function of its inputs (no I/O, no clock reads),
 * so the whole mapping surface sits under unit tests.
 *
 * The input is the file a Follow Up Boss admin downloads themselves from
 * People, with "Export All Columns" checked. We deliberately do NOT read
 * their API: their API Terms of Use require system registration and forbid
 * using the API or its data to offer a product that competes with them, so
 * the customer exporting their own data is the only path that is theirs to
 * give. Follow Up Boss documents that export as the way to move to another
 * system.
 *
 * Because the export's exact headers are not published and vary with the
 * columns a Smart List has enabled, headers are matched by PATTERN rather
 * than by a fixed list, and whatever fails to match is REPORTED to the owner
 * before anything is written. Guessing silently is how a migration produces
 * a contact list nobody trusts.
 */

import { normalizeContactNumber } from "@/lib/telnyx/format";
import { normalizeContactTags } from "@/lib/customer-memory/types";
import { emailContactKey } from "../../../supabase/functions/_shared/contact_key";

/** contacts.lead_source cap (contacts_lead_source_len_chk). */
const LEAD_SOURCE_MAX = 120;

/** MAX_CONTACT_TAG_LENGTH mirror for the fub:<stage> fallback tag. */
const STAGE_TAG_MAX = 40;

/**
 * Fixed FUB-default-stage -> platform lifecycle tag map (the tags the
 * auto-lifecycle tagger writes: New Lead / Contacted / Engaged / Booked).
 * Keys are lowercased FUB stage names. Anything unmapped becomes a
 * `fub:<stage>` tag so no stage information is silently dropped.
 */
export const FUB_STAGE_TO_LIFECYCLE_TAG: Record<string, string> = {
  lead: "New Lead",
  "attempted contact": "Contacted",
  contacted: "Contacted",
  nurture: "Contacted",
  "hot prospect": "Engaged",
  "active client": "Engaged",
  pending: "Booked"
};

/** The lifecycle (or fallback `fub:<stage>`) tag for a FUB stage name. */
export function fubStageTag(stage: string | null | undefined): string | null {
  const trimmed = (stage ?? "").trim();
  if (!trimmed) return null;
  const mapped = FUB_STAGE_TO_LIFECYCLE_TAG[trimmed.toLowerCase()];
  return mapped ?? `fub:${trimmed.toLowerCase()}`.slice(0, STAGE_TAG_MAX);
}

/** The canonical fields we can use out of an export. */
export type FubCsvField =
  | "firstName"
  | "lastName"
  | "name"
  | "email"
  | "phone"
  | "stage"
  | "source"
  | "tags";

/**
 * Header patterns per field, matched against `normalizeHeader` output (lower
 * case, spaces already collapsed to underscores). Numbered variants are
 * matched by the same pattern, so "Phone", "Phone 1" and "Mobile Phone 2" all
 * land on `phone` and are tried in file order.
 *
 * `email` and `phone` are MULTI-column fields (an export carries several);
 * every other field takes the first column that matches.
 */
export const FUB_HEADER_PATTERNS: Record<FubCsvField, RegExp> = {
  firstName: /^first(_?name)?$/,
  lastName: /^last(_?name)?$/,
  name: /^(full_?name|contact_?name|name)$/,
  email: /^(primary_)?e_?mails?(_address(es)?)?(_\d+)?$/,
  phone: /^(primary_|mobile_|cell_|home_|work_)?phones?(_number)?(_\d+)?$|^(mobile|cell)(_\d+)?$/,
  stage: /^(lead_)?stage$/,
  source: /^(lead_)?source$/,
  tags: /^tags?$/
};

/** Which header(s) in the file supply each field, in file order. */
export type FubHeaderMap = Record<FubCsvField, string[]>;

/**
 * Resolve a parsed header row onto the canonical fields. Returns the map plus
 * the headers nothing claimed, which the dry run shows the owner so a column
 * they care about is never dropped without them seeing it.
 */
export function matchFubHeaders(headers: string[]): {
  map: FubHeaderMap;
  unmatched: string[];
} {
  const map = {
    firstName: [],
    lastName: [],
    name: [],
    email: [],
    phone: [],
    stage: [],
    source: [],
    tags: []
  } as FubHeaderMap;
  const claimed = new Set<string>();
  for (const header of headers) {
    for (const field of Object.keys(FUB_HEADER_PATTERNS) as FubCsvField[]) {
      // Single-value fields keep the FIRST matching column; a later "Name"
      // column must not overwrite the one we already read.
      const multi = field === "email" || field === "phone";
      if (!multi && map[field].length > 0) continue;
      if (!FUB_HEADER_PATTERNS[field].test(header)) continue;
      map[field].push(header);
      claimed.add(header);
      break;
    }
  }
  return { map, unmatched: headers.filter((h) => !claimed.has(h)) };
}

/** True when the file has at least one column we could identify a person by. */
export function hasIdentityColumn(map: FubHeaderMap): boolean {
  return map.phone.length > 0 || map.email.length > 0;
}

export type MappedFubContact = {
  /** Canonical contact key: first usable phone, else the email key. */
  key: string;
  email: string | null;
  name: string | null;
  /** FUB lead source label -> contacts.lead_source (fill-only on update). */
  leadSource: string | null;
  /** Lifecycle/fallback stage tag + FUB tags passthrough, normalized. */
  tags: string[];
};

export type MappedOrSkipped<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Every value the row carries for a multi-column field, in file order. */
function cells(row: Record<string, string>, headers: string[]): string[] {
  return headers.map((h) => (row[h] ?? "").trim()).filter(Boolean);
}

/** First cell across the field's columns that normalizes to a usable number. */
function firstPhoneKey(row: Record<string, string>, map: FubHeaderMap): string | null {
  for (const raw of cells(row, map.phone)) {
    const normalized = normalizeContactNumber(raw);
    if (normalized.ok) return normalized.value;
  }
  return null;
}

/** First cell across the field's columns that passes the contact-key rules. */
function firstEmailKey(row: Record<string, string>, map: FubHeaderMap): string | null {
  for (const raw of cells(row, map.email)) {
    const key = emailContactKey(raw);
    if (key) return key;
  }
  return null;
}

/**
 * A tags cell holds a list. Follow Up Boss writes them comma separated;
 * semicolons and pipes show up in hand-edited sheets, so all three split.
 */
export function splitTagCell(raw: string): string[] {
  return raw
    .split(/[,;|]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * One export row -> the contact upsert shape. A row with no usable phone AND
 * no usable email has no identity on our side and is reported, not dropped
 * silently.
 */
export function mapFubCsvRow(
  row: Record<string, string>,
  map: FubHeaderMap,
  fileRow: number
): MappedOrSkipped<MappedFubContact> {
  const phoneKey = firstPhoneKey(row, map);
  const emailKey = firstEmailKey(row, map);
  const key = phoneKey ?? emailKey;
  if (!key) {
    return { ok: false, reason: `row ${fileRow}: no usable phone number or email address` };
  }
  // The stored address: the first valid one, whether or not it is the key
  // (a phone-keyed person keeps their address on the email column, which is
  // also what the identity core's email fold matches on).
  const email = emailKey ? emailKey.slice("email:".length) : null;
  const full = (map.name[0] ? row[map.name[0]] ?? "" : "").trim();
  const name =
    full ||
    [map.firstName[0], map.lastName[0]]
      .map((h) => (h ? (row[h] ?? "").trim() : ""))
      .filter(Boolean)
      .join(" ");
  const leadSource = (map.source[0] ? row[map.source[0]] ?? "" : "").trim().slice(0, LEAD_SOURCE_MAX);
  const stageTag = fubStageTag(map.stage[0] ? row[map.stage[0]] : null);
  const tagCell = map.tags[0] ? row[map.tags[0]] ?? "" : "";
  const tags = normalizeContactTags([
    ...(stageTag ? [stageTag] : []),
    ...splitTagCell(tagCell)
  ]);
  return {
    ok: true,
    value: {
      key,
      email,
      name: name || null,
      leadSource: leadSource || null,
      tags
    }
  };
}
