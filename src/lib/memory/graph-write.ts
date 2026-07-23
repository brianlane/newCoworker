/**
 * Memory-graph write path: deterministic entity resolution + fact
 * supersedence.
 *
 * Takes a parsed GraphExtraction (graph-extract.ts) and lands it in the
 * memory_entities / memory_facts tables:
 *
 *   Resolution — an extracted entity collapses onto an existing node when
 *   there is identity evidence: the model's own existing_id claim (verified
 *   against the index), a shared normalized phone number, a shared email, or
 *   an exact canonical-name/alias match within the same kind. Anything less
 *   creates a NEW node (upstream rule: same name ≠ same entity).
 *
 *   Supersedence — a new fact for the same (subject, predicate) with a
 *   different object marks the old active facts inactive (superseded_by →
 *   the new fact) instead of accumulating contradictions. An identical
 *   object is a no-op.
 *
 * All IO goes through injectable deps (graph-db.ts defaults) so the logic is
 * fully unit-testable.
 */

import type { ExtractedEntity, GraphExtraction } from "./graph-extract";
import {
  insertMemoryEntity,
  insertMemoryFact,
  listActiveFacts,
  listMemoryEntities,
  supersedeMemoryFacts,
  updateMemoryEntity,
  type MemoryEntityRow
} from "./graph-db";

/** Digits-only, last 10 (US-normalized) — matches how numbers are compared. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D+/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

export function normalizeEmail(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned) ? cleaned : null;
}

function normalizedName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

function entityPhones(row: MemoryEntityRow): Set<string> {
  const out = new Set<string>();
  for (const p of row.phones) {
    const n = normalizePhone(p);
    if (n) out.add(n);
  }
  return out;
}

function entityEmails(row: MemoryEntityRow): Set<string> {
  const out = new Set<string>();
  for (const e of row.emails) {
    const n = normalizeEmail(e);
    if (n) out.add(n);
  }
  return out;
}

function entityNames(row: MemoryEntityRow): Set<string> {
  const out = new Set<string>([normalizedName(row.canonical_name)]);
  for (const a of row.aliases) {
    const n = normalizedName(a);
    if (n) out.add(n);
  }
  return out;
}

/**
 * Resolve an extracted entity onto an existing node, identity evidence only:
 *   1. the model's existing_id claim, verified to be a real node,
 *   2. a shared normalized phone number,
 *   3. a shared normalized email,
 *   4. an exact canonical-name/alias match within the same kind.
 * Returns null when nothing qualifies (→ create a new node).
 */
export function resolveEntity(
  extracted: ExtractedEntity,
  index: MemoryEntityRow[]
): MemoryEntityRow | null {
  if (extracted.existingId) {
    const claimed = index.find((row) => row.id === extracted.existingId);
    if (claimed) return claimed;
  }

  const phones = new Set(
    extracted.phones.map(normalizePhone).filter((p): p is string => p !== null)
  );
  const emails = new Set(
    extracted.emails.map(normalizeEmail).filter((e): e is string => e !== null)
  );
  for (const row of index) {
    if (phones.size > 0) {
      const rowPhones = entityPhones(row);
      for (const p of phones) if (rowPhones.has(p)) return row;
    }
    if (emails.size > 0) {
      const rowEmails = entityEmails(row);
      for (const e of emails) if (rowEmails.has(e)) return row;
    }
  }

  const names = new Set([normalizedName(extracted.name), ...extracted.aliases.map(normalizedName)]);
  for (const row of index) {
    if (row.kind !== extracted.kind) continue;
    const rowNames = entityNames(row);
    for (const n of names) {
      if (n && rowNames.has(n)) return row;
    }
  }

  return null;
}

/** New aliases/phones/emails the extraction adds to an existing node. */
export function mergePatch(
  extracted: ExtractedEntity,
  row: MemoryEntityRow
): { aliases?: string[]; phones?: string[]; emails?: string[] } {
  const patch: { aliases?: string[]; phones?: string[]; emails?: string[] } = {};

  const knownNames = entityNames(row);
  const newAliases = [extracted.name, ...extracted.aliases].filter(
    (a) => !knownNames.has(normalizedName(a))
  );
  if (newAliases.length > 0) patch.aliases = [...row.aliases, ...newAliases];

  const knownPhones = entityPhones(row);
  const newPhones = extracted.phones.filter((p) => {
    const n = normalizePhone(p);
    return n !== null && !knownPhones.has(n);
  });
  if (newPhones.length > 0) patch.phones = [...row.phones, ...newPhones];

  const knownEmails = entityEmails(row);
  const newEmails = extracted.emails.filter((e) => {
    const n = normalizeEmail(e);
    return n !== null && !knownEmails.has(n);
  });
  if (newEmails.length > 0) patch.emails = [...row.emails, ...newEmails];

  return patch;
}

export type GraphWriteDeps = {
  listEntities?: typeof listMemoryEntities;
  insertEntity?: typeof insertMemoryEntity;
  updateEntity?: typeof updateMemoryEntity;
  listFacts?: typeof listActiveFacts;
  insertFact?: typeof insertMemoryFact;
  supersedeFacts?: typeof supersedeMemoryFacts;
};

export type GraphWriteResult = {
  entitiesCreated: number;
  entitiesMerged: number;
  factsInserted: number;
  factsSuperseded: number;
  factsSkipped: number;
};

/**
 * Land one extraction in the graph. Sequential by design — captures are
 * rare (owner chat) and ordering keeps supersedence deterministic.
 */
export async function applyGraphExtraction(
  businessId: string,
  extraction: GraphExtraction,
  bullets: string[],
  deps: GraphWriteDeps = {}
): Promise<GraphWriteResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const listEntities = deps.listEntities ?? listMemoryEntities;
  const insertEntity = deps.insertEntity ?? insertMemoryEntity;
  const updateEntity = deps.updateEntity ?? updateMemoryEntity;
  const listFacts = deps.listFacts ?? listActiveFacts;
  const insertFact = deps.insertFact ?? insertMemoryFact;
  const supersedeFacts = deps.supersedeFacts ?? supersedeMemoryFacts;
  /* c8 ignore stop */

  const result: GraphWriteResult = {
    entitiesCreated: 0,
    entitiesMerged: 0,
    factsInserted: 0,
    factsSuperseded: 0,
    factsSkipped: 0
  };
  if (extraction.entities.length === 0) return result;

  const index = await listEntities(businessId);
  const refToId = new Map<string, string>();

  for (const extracted of extraction.entities) {
    const resolved = resolveEntity(extracted, index);
    if (resolved) {
      refToId.set(extracted.ref, resolved.id);
      const patch = mergePatch(extracted, resolved);
      if (Object.keys(patch).length > 0) {
        await updateEntity(resolved.id, patch);
        // Keep the in-memory index current so later refs in this batch see
        // the merged aliases/phones/emails.
        if (patch.aliases) resolved.aliases = patch.aliases;
        if (patch.phones) resolved.phones = patch.phones;
        if (patch.emails) resolved.emails = patch.emails;
        result.entitiesMerged += 1;
      }
      continue;
    }
    const inserted = await insertEntity({
      business_id: businessId,
      kind: extracted.kind,
      canonical_name: extracted.name,
      aliases: extracted.aliases,
      phones: extracted.phones,
      emails: extracted.emails
    });
    index.push(inserted);
    refToId.set(extracted.ref, inserted.id);
    result.entitiesCreated += 1;
  }

  for (const fact of extraction.facts) {
    const subjectId = refToId.get(fact.subjectRef);
    /* c8 ignore next -- parse guarantees refs resolve; defensive backstop */
    if (!subjectId) continue;
    const objectId = fact.objectRef ? refToId.get(fact.objectRef) : null;
    /* c8 ignore next -- parse guarantees refs resolve; defensive backstop */
    if (fact.objectRef && !objectId) continue;
    const objectValue = fact.objectValue ?? "";
    // Exactly one of edge/literal (parse enforces; DB check backstops).
    if (!objectId && !objectValue) continue;
    const sourceText = bullets[fact.sourceIndex] ?? "";

    const existing = await listFacts(businessId, subjectId, fact.predicate);
    const sameObject = existing.find((row) =>
      objectId
        ? row.object_entity_id === objectId
        : (row.object_value ?? "").trim().toLowerCase() === objectValue.trim().toLowerCase()
    );
    if (sameObject) {
      result.factsSkipped += 1;
      continue;
    }

    const inserted = await insertFact({
      business_id: businessId,
      subject_entity_id: subjectId,
      predicate: fact.predicate,
      object_entity_id: objectId,
      object_value: objectId ? null : objectValue,
      source_text: sourceText
    });
    result.factsInserted += 1;

    const stale = existing.map((row) => row.id);
    if (stale.length > 0) {
      await supersedeFacts(stale, inserted.id);
      result.factsSuperseded += stale.length;
    }
  }

  return result;
}
