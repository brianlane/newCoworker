/**
 * Memory-graph ingestion orchestrator: mode gate → structured extraction →
 * resolution/supersedence write.
 *
 * Called fire-and-forget AFTER the bullet capture path persisted owner rules
 * (the owner-append route and the inline dashboard capture both call it), so
 * a graph failure can never break or slow a capture. Writes happen in
 * `shadow` AND `active` modes — shadow means retrieval doesn't affect live
 * answers yet, but the graph must accumulate for the shadow comparison to
 * mean anything. `off` (the default) is a hard no-op.
 */

import {
  GeminiEmptyError,
  geminiGenerateTextDetailed,
  type GeminiGenerateTextParams,
  type GeminiGenerateTextResult
} from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { logger } from "@/lib/logger";
import {
  GRAPH_EXTRACTION_SYSTEM_PROMPT,
  composeGraphExtractionInput,
  parseGraphExtraction,
  type EntityIndexEntry
} from "./graph-extract";
import { applyGraphExtraction, type GraphWriteResult } from "./graph-write";
import { getMemoryGraphMode, listMemoryEntities } from "./graph-db";

// Same tier as owner-rule capture: extracted structure becomes durable
// knowledge the coworker acts on for months, so quality beats pennies on
// this low-volume surface.
const DEFAULT_GRAPH_EXTRACT_MODEL = "gemini-3.5-flash-lite";

function resolveModel(): string {
  const configured = (process.env.MEMORY_GRAPH_EXTRACT_MODEL ?? "").trim();
  return configured.length > 0 ? configured : DEFAULT_GRAPH_EXTRACT_MODEL;
}

type GeminiCall = (params: GeminiGenerateTextParams) => Promise<GeminiGenerateTextResult>;

export type GraphIngestDeps = {
  /** Injectable Gemini call (tests). */
  generate?: GeminiCall;
  /** Injectable mode read (tests). */
  getMode?: typeof getMemoryGraphMode;
  /** Injectable entity-index read (tests). */
  listEntities?: typeof listMemoryEntities;
  /** Injectable write (tests). */
  apply?: typeof applyGraphExtraction;
};

/**
 * Extract entities/facts from freshly saved bullets and land them in the
 * tenant's graph. NEVER throws; returns what happened (for logging/tests).
 */
export async function ingestBulletsIntoGraph(
  businessId: string,
  bullets: string[],
  deps: GraphIngestDeps = {}
): Promise<{ ran: boolean; result?: GraphWriteResult }> {
  /* c8 ignore next 4 -- production defaults; tests inject */
  const generate = deps.generate ?? geminiGenerateTextDetailed;
  const getMode = deps.getMode ?? getMemoryGraphMode;
  const listEntities = deps.listEntities ?? listMemoryEntities;
  const apply = deps.apply ?? applyGraphExtraction;

  try {
    const cleaned = bullets.map((b) => b.trim()).filter(Boolean);
    if (cleaned.length === 0) return { ran: false };
    const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
    if (!apiKey) return { ran: false };

    const mode = await getMode(businessId);
    if (mode === "off") return { ran: false };

    const indexRows = await listEntities(businessId);
    const entityIndex: EntityIndexEntry[] = indexRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.canonical_name,
      aliases: row.aliases,
      phones: row.phones,
      emails: row.emails
    }));

    const model = resolveModel();
    const userText = composeGraphExtractionInput(cleaned, entityIndex);
    let text: string;
    let usage;
    try {
      ({ text, usage } = await generate({
        apiKey,
        model,
        systemInstruction: GRAPH_EXTRACTION_SYSTEM_PROMPT,
        userText,
        temperature: 0,
        maxOutputTokens: 2000,
        responseMimeType: "application/json"
      }));
    } catch (err) {
      if (err instanceof GeminiEmptyError) {
        await meterGeminiSpendForBusiness({
          businessId,
          model,
          surface: "memory_graph",
          usage: err.usage,
          inputChars: GRAPH_EXTRACTION_SYSTEM_PROMPT.length + userText.length,
          outputChars: 0
        });
      }
      logger.warn("memory-graph ingest: extract failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      return { ran: false };
    }
    await meterGeminiSpendForBusiness({
      businessId,
      model,
      surface: "memory_graph",
      usage,
      inputChars: GRAPH_EXTRACTION_SYSTEM_PROMPT.length + userText.length,
      outputChars: text.length
    });

    const extraction = parseGraphExtraction(text, cleaned.length);
    if (extraction.entities.length === 0) return { ran: true, result: undefined };

    const result = await apply(businessId, extraction, cleaned);
    logger.info("memory-graph ingest: applied", { businessId, ...result });
    return { ran: true, result };
  } catch (err) {
    logger.warn("memory-graph ingest failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ran: false };
  }
}
