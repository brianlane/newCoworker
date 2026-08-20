/**
 * Pure Follow Up Boss -> New Coworker mapping.
 *
 * Everything here is a plain function of its inputs (no I/O, no clock reads:
 * callers pass nowIso), so the whole mapping surface sits under unit tests.
 * Shapes follow the FUB reference docs (people-get, notes list, deals-get,
 * pipelines-get), fetched 2026-08-20.
 */

import { normalizeContactNumber } from "@/lib/telnyx/format";
import { normalizeContactTags } from "@/lib/customer-memory/types";
import { NOTE_AUTHOR_LABEL_MAX, NOTE_BODY_MAX } from "@/lib/notes/core";
import { MAX_DEAL_TITLE_LENGTH, MAX_DEAL_VALUE_CENTS, type DealStatus } from "@/lib/deals/core";
import { emailContactKey } from "../../../supabase/functions/_shared/contact_key";
import type { FubDeal, FubNote, FubPerson } from "./client";

/** Value both external_source columns carry for imported rows. */
export const FUB_EXTERNAL_SOURCE = "fub";

/** contacts.lead_source cap (contacts_lead_source_len_chk). */
const LEAD_SOURCE_MAX = 120;

/** MAX_CONTACT_TAG_LENGTH mirror for the fub:<stage> fallback tag. */
const STAGE_TAG_MAX = 40;

/**
 * Fixed FUB-default-stage -> platform lifecycle tag map (the tags the
 * auto-lifecycle tagger writes: New Lead / Contacted / Engaged / Booked).
 * Keys are lowercased FUB stage names. Anything unmapped becomes a
 * `fub:<stage>` tag so no stage information is silently dropped; Trash is
 * never imported (people-get excludes it by default).
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

/** First phone that normalizes to a usable contact number, as its key. */
function firstPhoneKey(person: FubPerson): string | null {
  for (const p of person.phones ?? []) {
    const normalized = normalizeContactNumber(p?.value ?? "");
    if (normalized.ok) return normalized.value;
  }
  return null;
}

/** First email that passes the contact-key address rules. */
function firstEmailKey(person: FubPerson): string | null {
  for (const e of person.emails ?? []) {
    const key = emailContactKey(e?.value ?? "");
    if (key) return key;
  }
  return null;
}

/**
 * FUB person -> the contact upsert shape. A person with no usable phone AND
 * no usable email has no identity on our side and is reported, not dropped
 * silently.
 */
export function mapFubPerson(person: FubPerson): MappedOrSkipped<MappedFubContact> {
  const phoneKey = firstPhoneKey(person);
  const emailKey = firstEmailKey(person);
  const key = phoneKey ?? emailKey;
  if (!key) {
    return { ok: false, reason: `person ${person.id}: no usable phone number or email address` };
  }
  // The stored address: the first valid one, whether or not it is the key
  // (a phone-keyed person keeps their address on the email column, which is
  // also what the identity core's email fold matches on).
  const email = emailKey ? emailKey.slice("email:".length) : null;
  const name =
    (person.name ?? "").trim() ||
    [person.firstName ?? "", person.lastName ?? ""].map((s) => s.trim()).filter(Boolean).join(" ");
  const leadSource = (person.source ?? "").trim().slice(0, LEAD_SOURCE_MAX);
  const stageTag = fubStageTag(person.stage);
  const tags = normalizeContactTags([
    ...(stageTag ? [stageTag] : []),
    ...(person.tags ?? [])
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

/**
 * Strip an HTML note body down to readable text: tags out, the handful of
 * entities FUB actually emits decoded, whitespace collapsed. Deliberately
 * simple; imported notes are a log, not rendered HTML.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** ISO-ish timestamp passthrough: parseable strings survive, junk drops. */
function validIso(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed || Number.isNaN(Date.parse(trimmed))) return null;
  return trimmed;
}

export type MappedFubNote = {
  /** contact_notes columns minus business_id/contact_id (caller resolves). */
  author_label: string;
  body: string;
  external_source: string;
  external_id: string;
  created_at: string;
  updated_at: string;
};

/**
 * FUB note -> contact_notes shape. Subject and body merge into one text
 * body (subject first, like an email), HTML bodies are stripped to text,
 * and the result is clamped to the platform note cap. Original FUB
 * timestamps ride along so imported history sorts where it happened,
 * falling back to `nowIso` (every row carries every column: PostgREST
 * bulk upserts require a uniform key set).
 */
export function mapFubNote(note: FubNote, nowIso: string): MappedOrSkipped<MappedFubNote> {
  const rawBody = (note.body ?? "").trim();
  const text = note.isHtml ? stripHtml(rawBody) : rawBody;
  const subject = (note.subject ?? "").trim();
  const combined = [subject, text].filter(Boolean).join("\n\n").trim();
  if (!combined) {
    return { ok: false, reason: `note ${note.id}: empty body` };
  }
  const author = (note.createdBy ?? "").trim();
  const created = validIso(note.created) ?? nowIso;
  const updated = validIso(note.updated) ?? created;
  return {
    ok: true,
    value: {
      author_label: (author || "Follow Up Boss").slice(0, NOTE_AUTHOR_LABEL_MAX),
      body: combined.slice(0, NOTE_BODY_MAX),
      external_source: FUB_EXTERNAL_SOURCE,
      external_id: String(note.id),
      created_at: created,
      updated_at: updated
    }
  };
}

/**
 * FUB pipeline stage name -> our deal funnel status. Keyword heuristic:
 * "lost" wins first so "Closed Lost" never reads as a win, then won/closed,
 * then contract/pending, else open.
 */
export function dealStatusFromStageName(stageName: string | null | undefined): DealStatus {
  const name = (stageName ?? "").toLowerCase();
  if (name.includes("lost")) return "lost";
  if (name.includes("won") || name.includes("closed")) return "won";
  if (name.includes("contract") || name.includes("pending")) return "under_contract";
  return "open";
}

export type MappedFubDeal = {
  /** deals columns minus business_id/contact_id (caller resolves). */
  title: string;
  value_cents: number | null;
  currency: string;
  expected_close_date: string | null;
  status: DealStatus;
  won_at: string | null;
  lost_at: string | null;
  external_source: string;
  external_id: string;
  created_at: string;
  updated_at: string;
  /** FUB person id of the primary linked person, for contact resolution. */
  personId: number | null;
};

/**
 * FUB deal -> deals shape. Price is dollars -> integer cents (0/absent means
 * "not sized", not $0). Archived/Deleted records are skipped (the fetch
 * excludes them by default; the guard covers accounts that return them
 * anyway). Terminal statuses stamp won_at/lost_at from the deal's
 * enteredStageAt (when it moved into its current, terminal stage), falling
 * back to createdAt then the import time.
 */
export function mapFubDeal(
  deal: FubDeal,
  stageNameById: Record<string, string>,
  nowIso: string
): MappedOrSkipped<MappedFubDeal> {
  const recordState = (deal.status ?? "").trim().toLowerCase();
  if (recordState && recordState !== "active") {
    return { ok: false, reason: `deal ${deal.id}: ${recordState} in Follow Up Boss` };
  }
  const stageName = deal.stageId != null ? stageNameById[String(deal.stageId)] ?? null : null;
  const status = dealStatusFromStageName(stageName);
  const title =
    ((deal.name ?? "").trim() || `Follow Up Boss deal ${deal.id}`).slice(0, MAX_DEAL_TITLE_LENGTH);
  const price = deal.price;
  const valueCents =
    typeof price === "number" && Number.isFinite(price) && price > 0
      ? Math.min(Math.round(price * 100), MAX_DEAL_VALUE_CENTS)
      : null;
  const close = (deal.projectedCloseDate ?? "").trim();
  const expectedCloseDate = /^\d{4}-\d{2}-\d{2}/.test(close) ? close.slice(0, 10) : null;
  const terminalStamp = validIso(deal.enteredStageAt) ?? validIso(deal.createdAt) ?? nowIso;
  const personId = deal.people?.[0]?.id ?? null;
  return {
    ok: true,
    value: {
      title,
      value_cents: valueCents,
      currency: "USD",
      expected_close_date: expectedCloseDate,
      status,
      won_at: status === "won" ? terminalStamp : null,
      lost_at: status === "lost" ? terminalStamp : null,
      external_source: FUB_EXTERNAL_SOURCE,
      external_id: String(deal.id),
      // FUB's creation time keeps the board's age ordering honest (and is
      // stable across re-runs); import time only when FUB omits it.
      created_at: validIso(deal.createdAt) ?? nowIso,
      updated_at: nowIso,
      personId
    }
  };
}
