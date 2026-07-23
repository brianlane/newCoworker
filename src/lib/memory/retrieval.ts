/**
 * Ranked memory retrieval for `business_knowledge_lookup`.
 *
 * Before this module, the lookup context carried the ENTIRE
 * `business_configs.memory_md` blob on every question — no ranking, while
 * documents already got two-stage term-overlap retrieval — and anything the
 * append path had evicted was unreachable. Memory now gets the same
 * treatment as documents: split into sections (the same section/chunk
 * boundaries the archive path uses), score by term overlap with the
 * question, and pack the best sections into a bounded budget. The archive
 * (`memory_archive_md`) participates, so facts that aged out of the active
 * 14KB window become answerable again.
 *
 * When nothing matches the question (or the question carries no scoreable
 * terms), we fall back to the NEWEST active sections — approximating the
 * old whole-blob behavior instead of stripping memory from the prompt.
 *
 * Deterministic and cheap by design: the voice adapter runs under a 3s
 * deadline, so selection cannot afford a model round-trip (same constraint
 * as document retrieval in src/lib/documents/core.ts).
 */

import { chunkMemorySection, splitMemorySections } from "@/lib/dashboard-chat/memory-append";

/**
 * Memory's share of the lookup prompt. The overall context budget is 12KB
 * (PROMPT_MAX_CONTEXT_CHARS in knowledge-tools/handlers.ts); capping memory
 * at half keeps room for documents, which previously could be crowded out
 * entirely when a full 14KB memory joined the prompt ahead of them.
 */
export const MEMORY_CONTEXT_MAX_CHARS = 6_000;

export type MemoryBlock = {
  text: string;
  source: "active" | "archive";
  /** Chronological rank across archive + active (higher = newer). */
  order: number;
};

/**
 * Split archive + active memory into scoreable blocks, oldest first
 * (archive precedes active — the archive holds evicted, older sections).
 */
export function memoryBlocks(activeMd: string, archiveMd: string): MemoryBlock[] {
  const blocks: MemoryBlock[] = [];
  let order = 0;
  for (const source of ["archive", "active"] as const) {
    const md = source === "archive" ? archiveMd : activeMd;
    for (const section of splitMemorySections(md)) {
      for (const chunk of chunkMemorySection(section)) {
        if (chunk.trim().length === 0) continue;
        blocks.push({ text: chunk, source, order: order++ });
      }
    }
  }
  return blocks;
}

/** Tokenize into lowercase word stems for the overlap score (doc parity). */
function questionTerms(question: string): string[] {
  return question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Relevance score: term overlap between the question and the block. A term
 * hit on the block's heading line (e.g. `## Hours`) counts extra, mirroring
 * the title weighting in scoreDocumentRelevance.
 */
export function scoreMemoryBlock(text: string, question: string): number {
  const terms = questionTerms(question);
  if (terms.length === 0) return 0;
  const headingLine = (text.split("\n").find((l) => /^\s*#{1,4}\s+/.test(l)) ?? "").toLowerCase();
  const body = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (headingLine.includes(term)) score += 2;
    if (body.includes(term)) score += 1;
  }
  return score;
}

export type MemorySelection = {
  /** Rendered context (chronological order) — "" when nothing was selected. */
  context: string;
  /** Number of blocks packed. */
  selected: number;
  /** How many of the packed blocks came from the archive. */
  fromArchive: number;
  /** True when no block matched the question and the newest-active fallback ran. */
  fallback: boolean;
};

/**
 * Pick the memory blocks most relevant to `question` and pack them into
 * `charBudget`, preferring higher scores and (on ties) newer blocks. Blocks
 * that don't fit are skipped, not truncated — chunking already bounds block
 * size at ~2KB so packing granularity stays fine.
 */
export function selectMemoryForQuestion(
  activeMd: string,
  archiveMd: string,
  question: string,
  charBudget: number = MEMORY_CONTEXT_MAX_CHARS
): MemorySelection {
  const empty: MemorySelection = { context: "", selected: 0, fromArchive: 0, fallback: false };
  if (charBudget <= 0) return empty;
  const blocks = memoryBlocks(activeMd, archiveMd);
  if (blocks.length === 0) return empty;

  const scored = blocks
    .map((block) => ({ block, score: scoreMemoryBlock(block.text, question) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.block.order - a.block.order);

  // Fallback: nothing matched — carry the NEWEST active sections so the
  // prompt never silently loses memory (old behavior injected the blob).
  const fallback = scored.length === 0;
  const ranked = fallback
    ? blocks
        .filter((b) => b.source === "active")
        .sort((a, b) => b.order - a.order)
        .map((block) => ({ block, score: 0 }))
    : scored;

  const included: MemoryBlock[] = [];
  let remaining = charBudget;
  for (const { block } of ranked) {
    // Joiner accounting is exact: total = Σ lengths + 2·(n−1), so only
    // blocks after the first pay for a "\n\n". Charging the first block +2
    // would skip a lone block that exactly fills the budget (Bugbot #844).
    const cost = block.text.length + (included.length === 0 ? 0 : 2);
    if (cost > remaining) continue;
    included.push(block);
    remaining -= cost;
  }
  if (included.length === 0) {
    // Nothing fit — even a question-relevant block can be a single
    // oversized line. Last resort: carry the newest end of ACTIVE memory
    // (the old inject-the-blob behavior never silently dropped memory
    // while some existed).
    const tailContext = activeMd.trim().slice(-charBudget).trim();
    if (!tailContext) return { ...empty, fallback };
    return { context: tailContext, selected: 1, fromArchive: 0, fallback: true };
  }

  included.sort((a, b) => a.order - b.order);
  return {
    context: included.map((b) => b.text).join("\n\n"),
    selected: included.length,
    fromArchive: included.filter((b) => b.source === "archive").length,
    fallback
  };
}
