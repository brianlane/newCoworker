import { getBusinessConfig } from "@/lib/db/configs";
import { getBusiness } from "@/lib/db/businesses";
import { listBusinessDocuments } from "@/lib/documents/db";
import {
  renderDocumentsContext,
  selectDocumentsForQuestion,
  type DocumentAudienceView
} from "@/lib/documents/core";
import { MEMORY_CONTEXT_MAX_CHARS, selectMemoryForQuestion } from "@/lib/memory/retrieval";
import { GRAPH_CONTEXT_MAX_CHARS, retrieveGraphContext } from "@/lib/memory/graph-retrieval";
import {
  GeminiEmptyError,
  geminiGenerateTextDetailed,
  type GeminiUsage
} from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { logger } from "@/lib/logger";

/**
 * Channel-agnostic core for the `business_knowledge_lookup` tool: answers a
 * business-specific question from the vault (identity/soul/website/memory)
 * plus the business's uploaded documents, with a short Gemini completion.
 *
 * Shared by every surface that exposes the tool:
 *   - voice  → /api/voice/tools/knowledge (bridge adapter)
 *   - sms + dashboard + webchat → /api/rowboat/tool-call (Rowboat webhook)
 *
 * Documents are audience-gated per surface: customer channels (voice / sms
 * / webchat) read as `clients` and only see client-audience docs; the owner
 * dashboard reads as `staff` and sees everything. Retrieval is two-stage —
 * a deterministic term-overlap ranking picks which docs' full contents fit
 * the prompt budget (no second model round-trip; the voice path runs under
 * a 3s deadline), and the rest are surfaced as title+summary mentions.
 *
 * Kept server-side (instead of "let the model answer from its prompt") for
 * the same reasons as the original voice adapter: prompts are trimmed
 * aggressively, and a tool-shaped answer forces the model to commit to
 * "found it" vs "didn't".
 */

export type KnowledgeToolResult = {
  ok: boolean;
  detail?: string;
  data?: { answer: string };
};

const PROMPT_MAX_CONTEXT_CHARS = 12_000;

/**
 * Maps the `askGemini` failure modes to a stable `detail` string forwarded
 * to the calling model. We deliberately differentiate between timeouts
 * (user should hear "give me a moment"), rate limits (retry later), upstream
 * server errors, empty responses, and missing-credential "skip the tool
 * entirely" cases so downstream telemetry + the model's reply stop blaming
 * every failure on a network timeout.
 */
export function classifyGeminiError(err: unknown): string {
  if (!(err instanceof Error)) return "gemini_error";
  if (err.name === "AbortError") return "timeout";
  const message = err.message;
  if (message === "gemini_unavailable") return "summarizer_unavailable";
  if (message === "gemini_empty") return "empty_answer";
  const httpMatch = /^gemini_http_(\d+)/.exec(message);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status === 429) return "rate_limited";
    if (status >= 500) return "upstream_error";
    return "upstream_client_error";
  }
  if (/abort/i.test(message)) return "timeout";
  return "gemini_error";
}

// gemini-3.5-flash-lite (GA Jul 21 2026): cheaper than the old
// gemini-3-flash-preview default ($0.30/$2.50 vs $0.50/$3.00 per 1M),
// stronger on this task class, 350 tok/s (matters under the 3s voice
// deadline), and a GA id — the 404 fallback should not sit on a preview.
const GEMINI_LOOKUP_DEFAULT_MODEL = "gemini-3.5-flash-lite";

type AskGeminiResult = {
  answer: string;
  /** Model the successful call actually ran on (primary or 404-fallback). */
  model: string;
  usage: GeminiUsage | null;
  /** Prompt size, for the metering fallback when usage is absent. */
  inputChars: number;
};

async function askGemini(
  question: string,
  context: string,
  businessId: string
): Promise<AskGeminiResult> {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) throw new Error("gemini_unavailable");
  const configured = process.env.GEMINI_ROWBOAT_MODEL?.trim();
  const primary = configured?.length ? configured : GEMINI_LOOKUP_DEFAULT_MODEL;
  const sys =
    "You answer caller questions about a specific small business using only the provided business knowledge. Reply in 1-2 short sentences meant to be read aloud. If the answer is not in the context, reply exactly: 'I don't have that handy - I'll make sure the team follows up.'";
  const userText = `Business knowledge:\n${context}\n\nCaller question: ${question}`;
  const inputChars = sys.length + userText.length;

  const runWithDeadline = async (model: string): Promise<AskGeminiResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const { text, usage } = await geminiGenerateTextDetailed({
        apiKey,
        model,
        systemInstruction: sys,
        userText,
        temperature: 0.1,
        // Gemini 3.x thinking counts against maxOutputTokens: at the old
        // cap of 200 the model spent ~190 tokens on hidden reasoning and
        // truncated the visible answer mid-sentence (live repro on Truly's
        // knowledge base: "What insurance products do we offer?" → "D&O").
        // `minimal` gives the whole budget to the answer — a lookup over an
        // already-retrieved 12k-char context needs no chain-of-thought —
        // and is also the fastest option under the 3s voice deadline
        // (~1.1-1.4s measured vs MAX_TOKENS truncation before). 300 keeps
        // the read-aloud backstop with headroom for list-style answers.
        // Gated on the model family: Gemini 2.5 rejects `thinkingLevel`
        // (numeric budgets only), and GEMINI_ROWBOAT_MODEL is operator-set.
        maxOutputTokens: 300,
        ...(/^gemini-3/i.test(model) ? { thinkingLevel: "minimal" as const } : {}),
        signal: controller.signal
      });
      return { answer: text, model, usage, inputChars };
    } catch (err) {
      // Empty replies (e.g. thinking-only output) are still billed by
      // Google — meter them here, where the model is known, then rethrow.
      if (err instanceof GeminiEmptyError) {
        await meterGeminiSpendForBusiness({
          businessId,
          model,
          surface: "knowledge_lookup",
          usage: err.usage,
          inputChars,
          outputChars: 0
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await runWithDeadline(primary);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "";
    if (/^gemini_http_404(?::|$)/.test(detail) && primary !== GEMINI_LOOKUP_DEFAULT_MODEL) {
      return await runWithDeadline(GEMINI_LOOKUP_DEFAULT_MODEL);
    }
    throw err;
  }
}

export async function lookupBusinessKnowledge(
  businessId: string,
  question: string,
  options: { audience?: DocumentAudienceView; callerE164?: string } = {}
): Promise<KnowledgeToolResult> {
  const audience = options.audience ?? "clients";
  const [config, business, documents] = await Promise.all([
    getBusinessConfig(businessId),
    getBusiness(businessId),
    // Documents must never break the base lookup: a table/read failure just
    // answers from the vault alone.
    listBusinessDocuments(businessId).catch((err) => {
      logger.warn("knowledge-tools: document list failed; answering from vault only", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      return [];
    })
  ]);

  const graphMode = config?.memory_graph_mode ?? "off";

  const parts: string[] = [];
  if (business?.name) parts.push(`Business name: ${business.name}`);
  if (config?.identity_md) parts.push(`# identity.md\n${config.identity_md}`);
  // Structured business profile (hours/address/contact) rendered from the
  // businesses row — the canonical answer source for "when are you open?".
  if (config?.profile_md) parts.push(`# profile.md\n${config.profile_md}`);
  if (config?.soul_md) parts.push(`# soul.md\n${config.soul_md}`);
  if (config?.website_md) parts.push(`# website.md\n${config.website_md}`);

  // Memory knowledge graph (per-tenant rollout via memory_graph_mode):
  //   shadow — compute + log the graph context; the live answer path stays
  //            byte-identical (the comparison feeds the Amy-first rollout).
  //   active — the graph context SUPPLEMENTS the ranked-markdown memory
  //            section (entity/relationship facts alongside the owner's
  //            saved notes — the graph's identity lines alone must never
  //            crowd out the note that actually answers the question).
  // Both graph and memory sections are budgeted against the remaining
  // prompt space (header + joiner reserved) so neither can push the
  // assembled context past the cap and silently truncate documents.
  // retrieveGraphContext never throws — a graph failure degrades to "".
  const graphHeader = "# memory graph (facts most relevant to the question)\n";
  let graphRetrieval = { context: "", matchedEntities: 0, facts: 0 };
  if (graphMode === "shadow" || graphMode === "active") {
    const graphBudget = Math.max(
      0,
      Math.min(
        GRAPH_CONTEXT_MAX_CHARS,
        PROMPT_MAX_CONTEXT_CHARS - parts.join("\n\n").length - (graphHeader.length + 2)
      )
    );
    graphRetrieval = await retrieveGraphContext(businessId, question, {
      callerE164: options.callerE164,
      charBudget: graphBudget
    });
  }
  if (graphMode === "active" && graphRetrieval.context.length > 0) {
    parts.push(`${graphHeader}${graphRetrieval.context}`);
  }

  // Ranked memory retrieval (same treatment documents get): score active +
  // archived memory sections against the question and pack only the most
  // relevant into a bounded share of the prompt. Archived facts — evicted
  // from the active 14KB window — stay answerable here.
  const memoryHeader = "# memory.md (saved notes most relevant to the question)\n";
  const memoryBudget = Math.max(
    0,
    Math.min(
      MEMORY_CONTEXT_MAX_CHARS,
      PROMPT_MAX_CONTEXT_CHARS - parts.join("\n\n").length - (memoryHeader.length + 2)
    )
  );
  const memorySelection = selectMemoryForQuestion(
    config?.memory_md ?? "",
    config?.memory_archive_md ?? "",
    question,
    memoryBudget
  );
  if (memorySelection.context) {
    parts.push(`${memoryHeader}${memorySelection.context}`);
  }

  if (graphMode === "shadow") {
    // Shadow telemetry: what the graph WOULD have contributed vs what the
    // ranked-markdown path carried. Log-only — zero behavior change.
    logger.info("kg_shadow_retrieval", {
      businessId,
      questionChars: question.length,
      graphMatchedEntities: graphRetrieval.matchedEntities,
      graphFacts: graphRetrieval.facts,
      graphContextChars: graphRetrieval.context.length,
      memoryContextChars: memorySelection.context.length,
      memoryFallback: memorySelection.fallback,
      callerProvided: Boolean(options.callerE164)
    });
  }

  // Two-stage document retrieval: pack the most relevant eligible docs'
  // full contents into whatever budget the vault left over; mention the
  // rest by title+summary. Expired and wrong-audience docs are excluded by
  // selectDocumentsForQuestion.
  const vaultContext = parts.join("\n\n");
  const docBudget = Math.max(0, PROMPT_MAX_CONTEXT_CHARS - vaultContext.length);
  const selection = selectDocumentsForQuestion(documents, question, audience, docBudget);
  const documentsContext = renderDocumentsContext(selection);
  if (documentsContext) parts.push(documentsContext);

  const context = parts.join("\n\n").slice(0, PROMPT_MAX_CONTEXT_CHARS);
  if (!context.trim()) {
    return { ok: false, detail: "knowledge_empty" };
  }

  try {
    const result = await askGemini(question, context, businessId);
    // Knowledge lookups run on the gemini-3 tier — meter them into the
    // shared AI budget so the billing-page number matches Google's bill.
    await meterGeminiSpendForBusiness({
      businessId,
      model: result.model,
      surface: "knowledge_lookup",
      usage: result.usage,
      inputChars: result.inputChars,
      outputChars: result.answer.length
    });
    return { ok: true, data: { answer: result.answer } };
  } catch (err) {
    logger.warn("knowledge-tools: gemini failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, detail: classifyGeminiError(err) };
  }
}
