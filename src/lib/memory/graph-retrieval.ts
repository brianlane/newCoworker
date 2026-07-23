/**
 * Memory-graph retrieval: question (+ optional caller identity) → matched
 * entities → 1-hop fact neighborhood → compact fact lines for the
 * knowledge-lookup prompt.
 *
 * Deterministic and cheap (no model round-trip — the voice adapter runs
 * under a 3s deadline): entities match on term overlap with the question
 * (name/alias hits) or on the caller's phone number; the context carries
 * every ACTIVE fact touching a matched entity, plus the identity line of
 * each entity pulled in through an edge (the 1-hop neighborhood).
 *
 * Used two ways by lookupBusinessKnowledge (memory_graph_mode):
 *   shadow — computed and logged alongside the live answer path, which
 *            stays byte-identical;
 *   active — replaces the ranked-markdown memory context (which remains
 *            the fallback when the graph has nothing relevant).
 */

import { logger } from "@/lib/logger";
import {
  listActiveFactsForBusiness,
  listMemoryEntities,
  type MemoryEntityRow
} from "./graph-db";
import { normalizePhone } from "./graph-write";

/** Graph share of the lookup prompt — same ballpark as ranked memory. */
export const GRAPH_CONTEXT_MAX_CHARS = 2_500;

/** Tokenize into lowercase word stems for the overlap match (doc parity). */
function questionTerms(question: string): string[] {
  return question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Entities the question (or caller identity) points at: a question term
 * equal to a whole WORD of the canonical name or an alias, or a
 * normalized-phone match on callerE164. Whole-word (not substring)
 * matching, because everyday three-letter terms live inside unrelated
 * names — "the" ⊂ "Theresa", "are" ⊂ "Warehouse" — and a false seed drags
 * its entire 1-hop neighborhood into the prompt.
 */
export function matchGraphEntities(
  entities: MemoryEntityRow[],
  question: string,
  callerE164?: string
): MemoryEntityRow[] {
  const terms = questionTerms(question);
  const callerDigits = callerE164 ? normalizePhone(callerE164) : null;
  const matched: MemoryEntityRow[] = [];
  for (const entity of entities) {
    const nameWords = new Set(
      [entity.canonical_name, ...entity.aliases].flatMap((n) => questionTerms(n))
    );
    const termHit = terms.some((term) => nameWords.has(term));
    const phoneHit =
      callerDigits !== null &&
      entity.phones.some((p) => normalizePhone(p) === callerDigits);
    if (termHit || phoneHit) matched.push(entity);
  }
  return matched;
}

export type GraphRetrieval = {
  /** Rendered fact lines — "" when nothing matched (or nothing fit). */
  context: string;
  /**
   * Matched (seed) entities — real match count even when the budget fit
   * nothing, so shadow telemetry can tell "no match" from "no room".
   */
  matchedEntities: number;
  /** Fact lines actually RENDERED into the context (not the neighborhood size). */
  facts: number;
};

/** One identity line per entity: name, kind, and stated contact points. */
function entityLine(entity: MemoryEntityRow): string {
  const bits: string[] = [];
  if (entity.aliases.length > 0) bits.push(`aka ${entity.aliases.join(", ")}`);
  if (entity.phones.length > 0) bits.push(`phone ${entity.phones.join(", ")}`);
  if (entity.emails.length > 0) bits.push(`email ${entity.emails.join(", ")}`);
  const detail = bits.length > 0 ? ` — ${bits.join("; ")}` : "";
  return `- ${entity.canonical_name} (${entity.kind})${detail}`;
}

/**
 * Retrieve the graph context for one question. Returns an empty context
 * (never throws upward — errors log and degrade) so callers can treat "no
 * graph" and "graph empty" identically.
 */
export async function retrieveGraphContext(
  businessId: string,
  question: string,
  options: {
    callerE164?: string;
    charBudget?: number;
    /** Injectable IO (tests). */
    listEntities?: typeof listMemoryEntities;
    listFacts?: typeof listActiveFactsForBusiness;
  } = {}
): Promise<GraphRetrieval> {
  const empty: GraphRetrieval = { context: "", matchedEntities: 0, facts: 0 };
  /* c8 ignore start -- production defaults; tests inject */
  const listEntities = options.listEntities ?? listMemoryEntities;
  const listFacts = options.listFacts ?? listActiveFactsForBusiness;
  /* c8 ignore stop */
  const charBudget = options.charBudget ?? GRAPH_CONTEXT_MAX_CHARS;

  try {
    const entities = await listEntities(businessId);
    if (entities.length === 0) return empty;
    const matched = matchGraphEntities(entities, question, options.callerE164);
    if (matched.length === 0) return empty;

    const byId = new Map(entities.map((e) => [e.id, e]));
    const matchedIds = new Set(matched.map((e) => e.id));

    const allFacts = await listFacts(businessId);
    const neighborhood = allFacts.filter(
      (f) =>
        matchedIds.has(f.subject_entity_id) ||
        (f.object_entity_id !== null && matchedIds.has(f.object_entity_id))
    );

    // Every entity the neighborhood touches gets an identity line, so an
    // edge like "Amy escalation_target Dave" always names both ends.
    const mentioned = new Set<string>(matchedIds);
    for (const f of neighborhood) {
      mentioned.add(f.subject_entity_id);
      if (f.object_entity_id) mentioned.add(f.object_entity_id);
    }

    // TRUST-AWARE RENDERING: owner/employee facts (trust ≥ 2) read as plain
    // statements; customer/anonymous facts (trust ≤ 1) are explicit CLAIMS
    // with their attribution, so the answering model always knows gospel
    // from hearsay. Facts pack higher-trust-first when the budget is tight.
    const claimSuffix = (f: { trust: number; attributed_to: string | null; source: string }) =>
      f.trust <= 1 ? ` — claimed by ${f.attributed_to ?? f.source} (unverified)` : "";

    const lines: Array<{ text: string; isFact: boolean; trust: number }> = [];
    for (const id of mentioned) {
      const entity = byId.get(id);
      /* c8 ignore next -- FK integrity guarantees mentioned ids exist */
      if (!entity) continue;
      lines.push({ text: entityLine(entity), isFact: false, trust: entity.trust });
    }
    const factLines: Array<{ text: string; isFact: boolean; trust: number }> = [];
    for (const f of neighborhood) {
      const subject = byId.get(f.subject_entity_id);
      /* c8 ignore next -- FK integrity guarantees the subject exists */
      if (!subject) continue;
      if (f.object_entity_id) {
        const object = byId.get(f.object_entity_id);
        /* c8 ignore next -- FK integrity guarantees the object exists */
        if (!object) continue;
        factLines.push({
          text: `- ${subject.canonical_name} ${f.predicate} ${object.canonical_name}${claimSuffix(f)}`,
          isFact: true,
          trust: f.trust
        });
      } else {
        factLines.push({
          text: `- ${subject.canonical_name} ${f.predicate}: ${f.object_value ?? ""}${claimSuffix(f)}`,
          isFact: true,
          trust: f.trust
        });
      }
    }
    factLines.sort((a, b) => b.trust - a.trust);
    lines.push(...factLines);

    // Pack lines in order (identity first, then facts) into the budget.
    const kept: Array<{ text: string; isFact: boolean }> = [];
    let remaining = charBudget;
    for (const line of lines) {
      const cost = line.text.length + (kept.length === 0 ? 0 : 1); // "\n" joiner
      if (cost > remaining) continue;
      kept.push(line);
      remaining -= cost;
    }
    // Even when nothing fits, report the real match counts so shadow
    // telemetry can tell "no match" from "matched but no room".
    return {
      context: kept.map((l) => l.text).join("\n"),
      matchedEntities: matched.length,
      facts: kept.filter((l) => l.isFact).length
    };
  } catch (err) {
    logger.warn("memory-graph retrieval failed; degrading to no graph context", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return empty;
  }
}