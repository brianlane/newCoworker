import { getBusinessConfig } from "@/lib/db/configs";
import { getBusiness } from "@/lib/db/businesses";
import { geminiGenerateText } from "@/lib/gemini-generate-content";
import { logger } from "@/lib/logger";

/**
 * Channel-agnostic core for the `business_knowledge_lookup` tool: answers a
 * business-specific question from the vault (identity/soul/website/memory)
 * with a short Gemini completion.
 *
 * Shared by every surface that exposes the tool:
 *   - voice  → /api/voice/tools/knowledge (bridge adapter)
 *   - sms + dashboard → /api/rowboat/tool-call (Rowboat project webhook)
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

const GEMINI_LOOKUP_DEFAULT_MODEL = "gemini-3-flash-preview";

async function askGemini(question: string, context: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) throw new Error("gemini_unavailable");
  const configured = process.env.GEMINI_ROWBOAT_MODEL?.trim();
  const primary = configured?.length ? configured : GEMINI_LOOKUP_DEFAULT_MODEL;
  const sys =
    "You answer caller questions about a specific small business using only the provided business knowledge. Reply in 1-2 short sentences meant to be read aloud. If the answer is not in the context, reply exactly: 'I don't have that handy - I'll make sure the team follows up.'";
  const userText = `Business knowledge:\n${context}\n\nCaller question: ${question}`;

  const runWithDeadline = async (model: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      return await geminiGenerateText({
        apiKey,
        model,
        systemInstruction: sys,
        userText,
        temperature: 0.1,
        maxOutputTokens: 200,
        signal: controller.signal
      });
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
  question: string
): Promise<KnowledgeToolResult> {
  const [config, business] = await Promise.all([
    getBusinessConfig(businessId),
    getBusiness(businessId)
  ]);

  const parts: string[] = [];
  if (business?.name) parts.push(`Business name: ${business.name}`);
  if (config?.identity_md) parts.push(`# identity.md\n${config.identity_md}`);
  if (config?.soul_md) parts.push(`# soul.md\n${config.soul_md}`);
  if (config?.website_md) parts.push(`# website.md\n${config.website_md}`);
  if (config?.memory_md) parts.push(`# memory.md\n${config.memory_md}`);

  const context = parts.join("\n\n").slice(0, PROMPT_MAX_CONTEXT_CHARS);
  if (!context.trim()) {
    return { ok: false, detail: "knowledge_empty" };
  }

  try {
    const answer = await askGemini(question, context);
    return { ok: true, data: { answer } };
  } catch (err) {
    logger.warn("knowledge-tools: gemini failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, detail: classifyGeminiError(err) };
  }
}
