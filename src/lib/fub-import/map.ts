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
 * The handful of HTML entities FUB note bodies actually carry. Keys are
 * lowercase; ENTITY_PATTERN below must match exactly these, and the unit
 * tests assert every one of them, so the two cannot drift apart.
 */
const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#039;": "'"
};

/** Every entity above, in one case-insensitive alternation. */
const ENTITY_PATTERN = /&(?:nbsp|amp|lt|gt|quot|#0?39);/gi;

/** Tag-stripping passes before we stop. Real note bodies settle in two. */
const MAX_TAG_STRIP_PASSES = 20;

/**
 * Strip an HTML note body down to readable text: tags out, the handful of
 * entities FUB actually emits decoded, whitespace collapsed. Deliberately
 * simple; imported notes are a log, not rendered HTML.
 */
export function stripHtml(html: string): string {
  // Breaks and block closers become newlines first, while the tags they live
  // on are still intact.
  let text = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n");
  // Then strip tags until the string stops changing. A single pass is the
  // incomplete sanitization CodeQL flags: removing a match joins whatever
  // sat on either side of it, and nested constructions like
  // `<scr<script>ipt>` are the classic way to rebuild a tag out of the
  // leftovers. Looping to a fixed point means the result carries no
  // `<...>` pair whatever the input; the cap stops pathological input from
  // looping without end.
  for (let pass = 0; pass < MAX_TAG_STRIP_PASSES; pass++) {
    const stripped = text.replace(/<[^>]*>/g, "");
    if (stripped === text) break;
    text = stripped;
  }
  // Entities LAST, and in a SINGLE pass through a replacer, so each entity
  // decodes exactly once and no decoded output is re-scanned: `&amp;lt;`
  // ends up as the literal text `&lt;`, never as `<`. Decoding after
  // stripping is deliberate too, so `5 &lt; 10 &gt; 3` keeps its numbers
  // instead of losing `< 10 >` to the tag regex. The result is plain text
  // stored in a text column and rendered escaped by React, so a decoded
  // `<script>` is literal characters on the page, not markup.
  return text
    .replace(ENTITY_PATTERN, (entity) => HTML_ENTITIES[entity.toLowerCase()])
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
