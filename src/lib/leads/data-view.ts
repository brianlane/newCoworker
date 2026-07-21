/**
 * Pure shaping for the Tasks page's Data view (the Airtable-style grid).
 *
 * One row per LEAD: every contact that is on a pipeline (has tags) plus
 * every lead_submissions row, folded together by identifier — a submission
 * whose phone matches a contact's primary/alias (or whose email matches the
 * contact's email) enriches that contact's row instead of adding a second
 * one. Submission answers become DYNAMIC columns: the union of field keys
 * across the shown rows, minus identifier/plumbing keys the fixed columns
 * already cover.
 *
 * Types-only + pure functions (no Supabase import) so the client grid can
 * import the shapes.
 */

import {
  isPhoneFieldName
} from "../../../supabase/functions/_shared/ai_flows/engine";

/** Most rows one response carries; newest lead first. */
export const MAX_LEAD_DATA_ROWS = 200;
/** Most dynamic columns the grid renders (first-seen across newest rows). */
export const MAX_DYNAMIC_COLUMNS = 12;

/** A lead_submissions row, as the route selects it. */
export type LeadSubmissionRow = {
  source: string;
  leadgen_id: string | null;
  fields: Record<string, string>;
  phone_e164: string | null;
  email: string | null;
  created_at: string;
};

/** The contact slice the route selects (same columns as the tasks API). */
export type LeadContactRow = {
  customer_e164: string;
  alias_e164s: string[] | null;
  display_name: string | null;
  email: string | null;
  summary_md: string | null;
  tags: string[] | null;
  owner_employee_id: string | null;
  created_at: string;
  updated_at: string;
};

export type LeadDataRow = {
  /** The lead's phone (contact primary, or the submission's), null when unknown. */
  e164: string | null;
  name: string;
  email: string | null;
  /** Contact tags — the client maps these onto pipeline stages. */
  tags: string[];
  ownerEmployeeId: string | null;
  ownerName: string | null;
  /** Source label of the newest submission ("facebook_lead_ads", ...). */
  source: string | null;
  /** The newest submission's answers (drives the dynamic columns). */
  fields: Record<string, string>;
  /** When the lead arrived: newest submission time, else contact creation. */
  createdAt: string;
  /** True when this row has a contact record (stage edits need one). */
  hasContact: boolean;
};

/**
 * Plumbing keys the bridges/direct integration attach that the grid's fixed
 * columns or metadata already cover — never worth a dynamic column.
 */
const DYNAMIC_COLUMN_DENYLIST = new Set([
  "leadgen_id",
  "form_id",
  "ad_id",
  "page_id",
  "created_time",
  "platform",
  "psid",
  "id",
  "event_id",
  "source"
]);

/** Is this field key rendered by a fixed column (phone/email/name)? */
export function isFixedColumnField(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (DYNAMIC_COLUMN_DENYLIST.has(normalized)) return true;
  if (isPhoneFieldName(key)) return true;
  const tokens = normalized.split(/[^a-z]+/).filter((t) => t.length > 0);
  return tokens.includes("email") || tokens.some((t) => t === "name");
}

/**
 * The dynamic column set: field keys in first-seen order across rows
 * (newest rows first, so a tenant's current form drives the layout),
 * skipping keys the fixed columns cover, capped at MAX_DYNAMIC_COLUMNS.
 */
export function dynamicFieldColumns(rows: LeadDataRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row.fields)) {
      if (seen.has(key) || isFixedColumnField(key)) continue;
      seen.add(key);
      out.push(key);
      if (out.length >= MAX_DYNAMIC_COLUMNS) return out;
    }
  }
  return out;
}

/**
 * Fold submissions onto contacts and produce the grid rows, newest lead
 * first. `contactNames` carries resolved display names (owner/employee
 * overlays win, same as every other dashboard surface).
 */
export function buildLeadDataRows(input: {
  submissions: LeadSubmissionRow[];
  contacts: LeadContactRow[];
  contactNames: Map<string, { name: string }>;
  employeeNameById: Map<string, string>;
  /**
   * "My leads" scope: keep only rows OWNED by this roster member. Applied
   * BEFORE the row cap, so an owned lead can never be pushed out of the
   * response by other people's newer leads (Board/List scope the same way).
   */
  scopeOwnerEmployeeId?: string | null;
}): LeadDataRow[] {
  const { submissions, contacts, contactNames, employeeNameById } = input;

  // Identifier → contact primary key (primary phone, aliases, email).
  const contactByKey = new Map<string, LeadContactRow>();
  for (const contact of contacts) {
    contactByKey.set(contact.customer_e164, contact);
    for (const alias of contact.alias_e164s ?? []) {
      if (!contactByKey.has(alias)) contactByKey.set(alias, contact);
    }
    const email = contact.email?.trim().toLowerCase();
    if (email && !contactByKey.has(`email:${email}`)) {
      contactByKey.set(`email:${email}`, contact);
    }
  }

  // Newest submission per lead. Submissions matching a contact key onto the
  // contact's primary; contactless submissions key on their own identifier
  // (phone, else email, else nothing — those each get their own row).
  const newestByLead = new Map<string, LeadSubmissionRow>();
  const contactless: LeadSubmissionRow[] = [];
  const sortedSubs = [...submissions].sort((a, b) =>
    a.created_at < b.created_at ? 1 : -1
  );
  for (const sub of sortedSubs) {
    const email = sub.email?.trim().toLowerCase();
    const contact =
      (sub.phone_e164 ? contactByKey.get(sub.phone_e164) : undefined) ??
      (email ? contactByKey.get(`email:${email}`) : undefined);
    const key = contact
      ? `c:${contact.customer_e164}`
      : sub.phone_e164
        ? `p:${sub.phone_e164}`
        : email
          ? `e:${email}`
          : null;
    if (key === null) {
      contactless.push(sub);
      continue;
    }
    if (!newestByLead.has(key)) newestByLead.set(key, sub);
  }

  const rows: LeadDataRow[] = [];
  const seenContacts = new Set<string>();

  const contactRow = (contact: LeadContactRow, sub: LeadSubmissionRow | undefined) => {
    const ownerName =
      (contact.owner_employee_id &&
        employeeNameById.get(contact.owner_employee_id)) ||
      null;
    return {
      e164: contact.customer_e164,
      name:
        contactNames.get(contact.customer_e164)?.name ??
        contact.display_name ??
        contact.customer_e164,
      email: contact.email ?? sub?.email ?? null,
      tags: contact.tags ?? [],
      ownerEmployeeId: contact.owner_employee_id,
      ownerName,
      source: sub?.source ?? null,
      fields: sub?.fields ?? {},
      createdAt: sub?.created_at ?? contact.created_at,
      hasContact: true
    } satisfies LeadDataRow;
  };

  for (const [key, sub] of newestByLead) {
    if (key.startsWith("c:")) {
      const contact = contactByKey.get(key.slice(2))!;
      seenContacts.add(contact.customer_e164);
      rows.push(contactRow(contact, sub));
      continue;
    }
    // Submission-only lead (no contact yet): the flow hasn't filed them.
    const nameField = Object.entries(sub.fields).find(([k, v]) => {
      const tokens = k.toLowerCase().split(/[^a-z]+/).filter(Boolean);
      return tokens.includes("name") && v.trim().length > 0;
    });
    rows.push({
      e164: sub.phone_e164,
      // A submission keyed here carries a phone or an email by construction.
      name: nameField?.[1].trim() ?? sub.phone_e164 ?? (sub.email as string),
      email: sub.email,
      tags: [],
      ownerEmployeeId: null,
      ownerName: null,
      source: sub.source,
      fields: sub.fields,
      createdAt: sub.created_at,
      hasContact: false
    });
  }

  // Tagged contacts with no submission still belong on the grid (they're on
  // a pipeline); untagged submission-less contacts are not leads in motion.
  for (const contact of contacts) {
    if (seenContacts.has(contact.customer_e164)) continue;
    if ((contact.tags ?? []).length === 0) continue;
    seenContacts.add(contact.customer_e164);
    rows.push(contactRow(contact, undefined));
  }

  // Contactless, identifier-less submissions each get a row (rare: a form
  // with neither phone nor email) — still visible rather than dropped.
  for (const sub of contactless) {
    rows.push({
      e164: null,
      name: "Lead",
      email: null,
      tags: [],
      ownerEmployeeId: null,
      ownerName: null,
      source: sub.source,
      fields: sub.fields,
      createdAt: sub.created_at,
      hasContact: false
    });
  }

  const scoped =
    input.scopeOwnerEmployeeId != null
      ? rows.filter((r) => r.ownerEmployeeId === input.scopeOwnerEmployeeId)
      : rows;
  scoped.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return scoped.slice(0, MAX_LEAD_DATA_ROWS);
}
