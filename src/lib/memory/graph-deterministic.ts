/**
 * Deterministic knowledge-graph ingestion — structured platform data maps
 * straight to entities/facts with ZERO model cost (PR 3 of the KG plan).
 *
 * Each builder turns one structured event into a GraphExtraction and lands
 * it through the SAME resolution/supersedence path LLM capture uses
 * (applyGraphExtraction), so a roster member, a webhook lead, and an
 * owner-stated rule all collapse onto the same canonical nodes with their
 * per-source trust (kg-sources.ts).
 *
 * Every ingest is mode-gated and NEVER throws — hook sites await them
 * knowing a graph failure can't break the write they piggyback on.
 */

import { logger } from "@/lib/logger";
import type { GraphExtraction } from "./graph-extract";
import { applyGraphExtraction, type GraphProvenance } from "./graph-write";
import {
  deactivateMemoryFacts,
  getMemoryGraphMode,
  listActiveFacts,
  listMemoryEntities
} from "./graph-db";
import { kgSourceTrust } from "./kg-sources";

export type DeterministicIngestDeps = {
  /** Injectable mode read (tests). */
  getMode?: typeof getMemoryGraphMode;
  /** Injectable write (tests). */
  apply?: typeof applyGraphExtraction;
};

/**
 * Shared mode-gate + apply. Returns whether a write ran (for tests/logs);
 * swallows and logs every failure.
 */
export async function ingestDeterministic(
  businessId: string,
  extraction: GraphExtraction,
  sourceText: string,
  provenance: GraphProvenance,
  deps: DeterministicIngestDeps = {}
): Promise<{ ran: boolean }> {
  /* c8 ignore next 2 -- production defaults; tests inject */
  const getMode = deps.getMode ?? getMemoryGraphMode;
  const apply = deps.apply ?? applyGraphExtraction;
  try {
    if (extraction.entities.length === 0) return { ran: false };
    const mode = await getMode(businessId);
    if (mode === "off") return { ran: false };
    await apply(businessId, extraction, [sourceText], {}, provenance);
    return { ran: true };
  } catch (err) {
    logger.warn("graph-deterministic ingest failed (ignored)", {
      businessId,
      source: provenance.source,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ran: false };
  }
}

const clean = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 200) : "";

// ── Team roster (kg-source: team_roster) ─────────────────────────────────

export function rosterExtraction(member: {
  name: string;
  phoneE164?: string | null;
  email?: string | null;
}): GraphExtraction {
  const name = clean(member.name);
  if (!name) return { entities: [], facts: [] };
  return {
    entities: [
      {
        ref: "e1",
        kind: "person",
        name,
        aliases: [],
        phones: member.phoneE164 ? [member.phoneE164] : [],
        emails: member.email ? [member.email] : []
      }
    ],
    facts: [{ subjectRef: "e1", predicate: "role", objectValue: "employee", sourceIndex: 0 }]
  };
}

export async function ingestRosterMember(
  businessId: string,
  member: { name: string; phoneE164?: string | null; email?: string | null },
  deps: DeterministicIngestDeps = {}
): Promise<{ ran: boolean }> {
  return ingestDeterministic(
    businessId,
    rosterExtraction(member),
    `Team roster: ${clean(member.name)}`,
    { source: "team_roster", trust: kgSourceTrust("team_roster"), attributedTo: null },
    deps
  );
}

// ── Contacts + owner-pinned notes (kg-source: contacts /
//    kg-source: customer_pinned_notes) ─────────────────────────────────────

export function contactExtraction(contact: {
  displayName?: string | null;
  e164: string;
  email?: string | null;
}): GraphExtraction {
  const name = clean(contact.displayName);
  // A nameless contact is just a number — nothing entity-shaped to add
  // beyond what customer_memories already tracks.
  if (!name) return { entities: [], facts: [] };
  return {
    entities: [
      {
        ref: "e1",
        kind: "person",
        name,
        aliases: [],
        phones: [contact.e164],
        emails: contact.email ? [contact.email] : []
      }
    ],
    facts: []
  };
}

export async function ingestContact(
  businessId: string,
  contact: { displayName?: string | null; e164: string; email?: string | null },
  deps: DeterministicIngestDeps = {}
): Promise<{ ran: boolean }> {
  return ingestDeterministic(
    businessId,
    contactExtraction(contact),
    `Contact: ${clean(contact.displayName)} ${contact.e164}`,
    { source: "contacts", trust: kgSourceTrust("contacts"), attributedTo: null },
    deps
  );
}

export function pinnedNoteExtraction(contact: {
  displayName?: string | null;
  e164: string;
  note: string;
}): GraphExtraction {
  const note = contact.note.replace(/\s+/g, " ").trim().slice(0, 500);
  const name = clean(contact.displayName) || contact.e164;
  if (!note) return { entities: [], facts: [] };
  return {
    entities: [
      { ref: "e1", kind: "person", name, aliases: [], phones: [contact.e164], emails: [] }
    ],
    facts: [{ subjectRef: "e1", predicate: "owner_note", objectValue: note, sourceIndex: 0 }]
  };
}

export async function ingestPinnedNote(
  businessId: string,
  contact: { displayName?: string | null; e164: string; note: string },
  deps: DeterministicIngestDeps = {}
): Promise<{ ran: boolean }> {
  return ingestDeterministic(
    businessId,
    pinnedNoteExtraction(contact),
    `Owner pinned note for ${contact.e164}`,
    {
      source: "customer_pinned_notes",
      trust: kgSourceTrust("customer_pinned_notes"),
      attributedTo: null
    },
    deps
  );
}

export type RetireNoteDeps = {
  getMode?: typeof getMemoryGraphMode;
  listEntities?: typeof listMemoryEntities;
  listFacts?: typeof listActiveFacts;
  deactivate?: typeof deactivateMemoryFacts;
};

/**
 * Owner CLEARED a pinned note → retire the graph's active owner_note facts
 * on that person, or prompts would keep treating removed content as
 * current owner knowledge. Resolution is by exact phone match (the same
 * identity evidence the write path uses); no matching entity is a clean
 * no-op. Never-throws, mode-gated.
 */
export async function retirePinnedNote(
  businessId: string,
  e164: string,
  deps: RetireNoteDeps = {}
): Promise<{ retired: number }> {
  /* c8 ignore start -- production defaults; tests inject */
  const getMode = deps.getMode ?? getMemoryGraphMode;
  const listEntities = deps.listEntities ?? listMemoryEntities;
  const listFacts = deps.listFacts ?? listActiveFacts;
  const deactivate = deps.deactivate ?? deactivateMemoryFacts;
  /* c8 ignore stop */
  try {
    const mode = await getMode(businessId);
    if (mode === "off") return { retired: 0 };
    const entities = await listEntities(businessId);
    const person = entities.find((row) => row.phones.includes(e164));
    if (!person) return { retired: 0 };
    const facts = await listFacts(businessId, person.id, "owner_note");
    if (facts.length === 0) return { retired: 0 };
    await deactivate(facts.map((f) => f.id));
    return { retired: facts.length };
  } catch (err) {
    logger.warn("graph-deterministic pinned-note retire failed (ignored)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { retired: 0 };
  }
}

// ── Business profile (kg-source: business_profile) ───────────────────────

export function profileExtraction(profile: {
  businessName: string;
  address?: string | null;
  phoneE164?: string | null;
  hoursSummary?: string | null;
}): GraphExtraction {
  const name = clean(profile.businessName);
  if (!name) return { entities: [], facts: [] };
  const facts: GraphExtraction["facts"] = [];
  const address = clean(profile.address);
  if (address) facts.push({ subjectRef: "e1", predicate: "address", objectValue: address, sourceIndex: 0 });
  const hours = clean(profile.hoursSummary);
  if (hours) facts.push({ subjectRef: "e1", predicate: "hours", objectValue: hours, sourceIndex: 0 });
  return {
    entities: [
      {
        ref: "e1",
        kind: "organization",
        name,
        aliases: [],
        phones: profile.phoneE164 ? [profile.phoneE164] : [],
        emails: []
      }
    ],
    facts
  };
}

export async function ingestBusinessProfile(
  businessId: string,
  profile: {
    businessName: string;
    address?: string | null;
    phoneE164?: string | null;
    hoursSummary?: string | null;
  },
  deps: DeterministicIngestDeps = {}
): Promise<{ ran: boolean }> {
  return ingestDeterministic(
    businessId,
    profileExtraction(profile),
    `Business profile: ${clean(profile.businessName)}`,
    { source: "business_profile", trust: kgSourceTrust("business_profile"), attributedTo: null },
    deps
  );
}

// ── AiFlow / webhook leads (kg-source: aiflow_lead) ──────────────────────

/** Pull a display name out of flattened lead fields (best-effort). */
export function leadName(fields: Record<string, string>): string {
  const direct = clean(fields.full_name ?? fields.name ?? fields.fullname);
  if (direct) return direct;
  const first = clean(fields.first_name ?? fields.firstname);
  const last = clean(fields.last_name ?? fields.lastname);
  return [first, last].filter(Boolean).join(" ");
}

export function leadExtraction(lead: {
  source: string;
  fields: Record<string, string>;
  phoneE164?: string | null;
  email?: string | null;
}): GraphExtraction {
  // A nameless lead with a phone/email still creates an identifier-named
  // node (same convention as bookings) — later contact/conversation ingests
  // resolve onto it via phone/email match and enrich the name. Only a lead
  // with NO identity at all builds nothing.
  const name = leadName(lead.fields) || clean(lead.phoneE164) || clean(lead.email);
  if (!name) return { entities: [], facts: [] };
  const facts: GraphExtraction["facts"] = [
    { subjectRef: "e1", predicate: "lead_source", objectValue: clean(lead.source), sourceIndex: 0 }
  ];
  const campaign = clean(lead.fields.campaign_name ?? lead.fields.campaign ?? lead.fields.ad_name);
  if (campaign) {
    facts.push({ subjectRef: "e1", predicate: "campaign", objectValue: campaign, sourceIndex: 0 });
  }
  const interest = clean(
    lead.fields.interested_in ?? lead.fields.interest ?? lead.fields.service ?? lead.fields.property
  );
  if (interest) {
    facts.push({ subjectRef: "e1", predicate: "interested_in", objectValue: interest, sourceIndex: 0 });
  }
  return {
    entities: [
      {
        ref: "e1",
        kind: "person",
        name,
        aliases: [],
        phones: lead.phoneE164 ? [lead.phoneE164] : [],
        emails: lead.email ? [lead.email] : []
      }
    ],
    facts
  };
}

export async function ingestLeadSubmission(
  businessId: string,
  lead: {
    source: string;
    fields: Record<string, string>;
    phoneE164?: string | null;
    email?: string | null;
  },
  deps: DeterministicIngestDeps = {}
): Promise<{ ran: boolean }> {
  return ingestDeterministic(
    businessId,
    leadExtraction(lead),
    `Lead submission via ${clean(lead.source)}`,
    {
      source: "aiflow_lead",
      trust: kgSourceTrust("aiflow_lead"),
      attributedTo: clean(lead.source) || "webhook"
    },
    deps
  );
}

// ── Bookings (kg-source: booking) ─────────────────────────────────────────

export function bookingExtraction(booking: {
  name?: string | null;
  phoneE164?: string | null;
  email?: string | null;
  detail: string;
}): GraphExtraction {
  const name = clean(booking.name) || clean(booking.phoneE164) || clean(booking.email);
  if (!name) return { entities: [], facts: [] };
  return {
    entities: [
      {
        ref: "e1",
        kind: "person",
        name,
        aliases: [],
        phones: booking.phoneE164 ? [booking.phoneE164] : [],
        emails: booking.email ? [booking.email] : []
      }
    ],
    facts: [
      {
        subjectRef: "e1",
        predicate: "booked_appointment",
        objectValue: clean(booking.detail) || "appointment booked",
        sourceIndex: 0
      }
    ]
  };
}

export async function ingestBooking(
  businessId: string,
  booking: { name?: string | null; phoneE164?: string | null; email?: string | null; detail: string },
  deps: DeterministicIngestDeps = {}
): Promise<{ ran: boolean }> {
  return ingestDeterministic(
    businessId,
    bookingExtraction(booking),
    `Booking: ${clean(booking.detail)}`,
    { source: "booking", trust: kgSourceTrust("booking"), attributedTo: null },
    deps
  );
}

// ── doc_extract record fields (kg-source: doc_extract_fields) ────────────

export function docRecordExtraction(doc: {
  title: string;
  fields: Record<string, string>;
  contactName?: string | null;
  contactE164?: string | null;
}): GraphExtraction {
  const name = clean(doc.contactName) || clean(doc.contactE164);
  if (!name) return { entities: [], facts: [] };
  const facts: GraphExtraction["facts"] = [];
  for (const [key, value] of Object.entries(doc.fields)) {
    const predicate = key
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60);
    const cleanedValue = clean(value);
    if (!predicate || !cleanedValue) continue;
    facts.push({ subjectRef: "e1", predicate, objectValue: cleanedValue, sourceIndex: 0 });
    if (facts.length >= 20) break;
  }
  if (facts.length === 0) return { entities: [], facts: [] };
  return {
    entities: [
      {
        ref: "e1",
        kind: "person",
        name,
        aliases: [],
        phones: doc.contactE164 ? [doc.contactE164] : [],
        emails: []
      }
    ],
    facts
  };
}

export async function ingestDocRecordFields(
  businessId: string,
  doc: {
    title: string;
    fields: Record<string, string>;
    contactName?: string | null;
    contactE164?: string | null;
  },
  deps: DeterministicIngestDeps = {}
): Promise<{ ran: boolean }> {
  return ingestDeterministic(
    businessId,
    docRecordExtraction(doc),
    `Document fields: ${clean(doc.title)}`,
    {
      source: "doc_extract_fields",
      trust: kgSourceTrust("doc_extract_fields"),
      attributedTo: clean(doc.title) || null
    },
    deps
  );
}
