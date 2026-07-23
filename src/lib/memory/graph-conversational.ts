/**
 * Conversational knowledge-graph extraction (PR 4 of the KG plan): LLM
 * extraction over CUSTOMER conversation windows — voice/SMS/email via the
 * customer-memory summarizer boundary, cold inbound email via the mailbox
 * hook — under the customer-source prompt (statements are claims; the
 * assistant's own turns are never extracted) and the per-source trust
 * model.
 *
 * COST FUSE: every extraction is metered on the `memory_graph` surface, and
 * a per-tenant DAILY cap (MEMORY_GRAPH_DAILY_EXTRACTION_CAP, default 200)
 * is enforced by reading today's call count back from the spend ledger — a
 * viral webchat day can't run up a Gemini bill. Over-cap windows are
 * logged (counted, not silent) and simply extract in a later window: the
 * summarizer re-assembles the same history next interaction, so nothing is
 * permanently lost.
 *
 * NEVER throws — every hook site piggybacks a write the caller must not
 * lose.
 */

import {
  GeminiEmptyError,
  geminiGenerateTextDetailed,
  type GeminiGenerateTextParams,
  type GeminiGenerateTextResult
} from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import {
  CUSTOMER_GRAPH_EXTRACTION_SYSTEM_PROMPT,
  composeConversationExtractionInput,
  parseGraphExtraction,
  type EntityIndexEntry
} from "./graph-extract";
import { applyGraphExtraction, type GraphWriteResult } from "./graph-write";
import { getMemoryGraphMode, listMemoryEntities } from "./graph-db";
import { kgSourceTrust, type KgSource } from "./kg-sources";

const DEFAULT_GRAPH_EXTRACT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_DAILY_EXTRACTION_CAP = 200;

/** Transcript windows larger than this are tail-trimmed (newest kept). */
export const CONVERSATION_EXTRACT_MAX_CHARS = 24_000;

function resolveModel(): string {
  const configured = (process.env.MEMORY_GRAPH_EXTRACT_MODEL ?? "").trim();
  return configured.length > 0 ? configured : DEFAULT_GRAPH_EXTRACT_MODEL;
}

/** Per-tenant daily extraction cap (env-tunable; 0/garbage → default). */
export function dailyExtractionCap(): number {
  const raw = Number.parseInt(process.env.MEMORY_GRAPH_DAILY_EXTRACTION_CAP ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_EXTRACTION_CAP;
}

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Today's (UTC) metered memory_graph call count for one tenant, read back
 * from the gemini_spend_daily roll-up — the same ledger the admin Gemini
 * page bills against, so the fuse and the bill can never disagree.
 */
export async function countKgExtractionsToday(
  businessId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await db
    .from("gemini_spend_daily")
    .select("call_count")
    .eq("business_id", businessId)
    .eq("surface", "memory_graph")
    .eq("day", today);
  if (error) throw new Error(`countKgExtractionsToday: ${error.message}`);
  return ((data ?? []) as Array<{ call_count: number }>).reduce(
    (sum, row) => sum + row.call_count,
    0
  );
}

/** Which conversational source a mixed summarizer window is stamped as. */
export function dominantConversationSource(counts: {
  voiceTurns: number;
  smsTurns: number;
  emails: number;
}): KgSource {
  if (counts.voiceTurns > 0) return "voice_call";
  if (counts.smsTurns > 0) return "customer_sms";
  return "email_replied";
}

type GeminiCall = (params: GeminiGenerateTextParams) => Promise<GeminiGenerateTextResult>;

export type ConversationExtractDeps = {
  /** Injectable Gemini call (tests). */
  generate?: GeminiCall;
  /** Injectable mode read (tests). */
  getMode?: typeof getMemoryGraphMode;
  /** Injectable entity-index read (tests). */
  listEntities?: typeof listMemoryEntities;
  /** Injectable write (tests). */
  apply?: typeof applyGraphExtraction;
  /** Injectable daily-count read (tests). */
  countToday?: typeof countKgExtractionsToday;
};

export type ConversationExtractInput = {
  /** The conversation window (customer + assistant turns, labeled). */
  transcript: string;
  /** Registry source key — decides the stored trust tier. */
  source: KgSource;
  /** Who the customer is (E.164, email address, or platform id). */
  attributedTo: string | null;
};

export type ConversationExtractOutcome = {
  ran: boolean;
  reason?: "empty" | "no_api_key" | "mode_off" | "daily_cap" | "extract_failed" | "error";
  result?: GraphWriteResult;
};

/**
 * Extract entities/facts from one customer-conversation window and land
 * them at the source's trust with attribution. NEVER throws.
 */
export async function extractConversationGraph(
  businessId: string,
  input: ConversationExtractInput,
  deps: ConversationExtractDeps = {}
): Promise<ConversationExtractOutcome> {
  /* c8 ignore next 5 -- production defaults; tests inject */
  const generate = deps.generate ?? geminiGenerateTextDetailed;
  const getMode = deps.getMode ?? getMemoryGraphMode;
  const listEntities = deps.listEntities ?? listMemoryEntities;
  const apply = deps.apply ?? applyGraphExtraction;
  const countToday = deps.countToday ?? countKgExtractionsToday;

  try {
    const transcript = input.transcript.trim().slice(-CONVERSATION_EXTRACT_MAX_CHARS);
    if (!transcript) return { ran: false, reason: "empty" };
    const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
    if (!apiKey) return { ran: false, reason: "no_api_key" };

    const mode = await getMode(businessId);
    if (mode === "off") return { ran: false, reason: "mode_off" };

    // Cost fuse — counted, never silent; the next window re-covers this
    // history (the summarizer window is rolling, the email hook is per-mail).
    const cap = dailyExtractionCap();
    const usedToday = await countToday(businessId);
    if (usedToday >= cap) {
      logger.info("memory-graph conversation extract: daily cap reached; deferred", {
        businessId,
        source: input.source,
        usedToday,
        cap
      });
      return { ran: false, reason: "daily_cap" };
    }

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
    const userText = composeConversationExtractionInput(transcript, entityIndex);
    let text: string;
    let usage;
    try {
      ({ text, usage } = await generate({
        apiKey,
        model,
        systemInstruction: CUSTOMER_GRAPH_EXTRACTION_SYSTEM_PROMPT,
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
          inputChars: CUSTOMER_GRAPH_EXTRACTION_SYSTEM_PROMPT.length + userText.length,
          outputChars: 0
        });
      }
      logger.warn("memory-graph conversation extract: extract failed", {
        businessId,
        source: input.source,
        error: err instanceof Error ? err.message : String(err)
      });
      return { ran: false, reason: "extract_failed" };
    }
    await meterGeminiSpendForBusiness({
      businessId,
      model,
      surface: "memory_graph",
      usage,
      inputChars: CUSTOMER_GRAPH_EXTRACTION_SYSTEM_PROMPT.length + userText.length,
      outputChars: text.length
    });

    // sourceCount 1: the whole transcript is one source text.
    const extraction = parseGraphExtraction(text, 1);
    if (extraction.entities.length === 0) return { ran: true, result: undefined };

    const result = await apply(businessId, extraction, [transcript], {}, {
      source: input.source,
      trust: kgSourceTrust(input.source),
      attributedTo: input.attributedTo
    });
    logger.info("memory-graph conversation extract: applied", {
      businessId,
      source: input.source,
      ...result
    });
    return { ran: true, result };
  } catch (err) {
    logger.warn("memory-graph conversation extract failed", {
      businessId,
      source: input.source,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ran: false, reason: "error" };
  }
}
