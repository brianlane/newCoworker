/**
 * Agents — run executor.
 *
 * One agent run = one Gemini transformation: the agent's saved instructions
 * applied to an attachment (decoded text for txt/md/csv, native inlineData
 * for PDFs — same split as documents/ingest.ts). Caller-agnostic by design:
 * the dashboard run route and a future run_agent AiFlow step both call
 * `executeAgentRun` with either `{ text }` or `{ bytes, mime }` input.
 * Every call (including billed-but-empty replies) is metered into the
 * shared AI budget under the `agent_run` surface.
 */

import {
  GeminiEmptyError,
  geminiGenerateTextDetailed,
  type GeminiGenerateTextParams,
  type GeminiGenerateTextResult,
  type GeminiUsage
} from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { logger } from "@/lib/logger";
import {
  AGENT_INPUT_MAX_TEXT_CHARS,
  AGENT_RUN_SYSTEM_PROMPT,
  buildAgentRunPrompt,
  buildOutputFilename,
  normalizeAgentOutput,
  resolveOutputTarget,
  type AgentOutputFormat
} from "./core";
import { VTT_MIME_TYPE, vttToPlainText } from "@/lib/transcripts/vtt";

/** Text formats decoded locally; PDFs go to Gemini as inlineData. */
export const AGENT_TEXT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  // Meeting transcripts (Zoom/Meet/Teams). Converted to "Speaker: sentence"
  // lines before prompting — see transcripts/vtt.ts.
  VTT_MIME_TYPE
] as const;
export const AGENT_PDF_MIME_TYPE = "application/pdf";

const DEFAULT_AGENT_MODEL = "gemini-3.5-flash";

function resolveModel(): string {
  const configured = (process.env.AGENT_RUN_MODEL ?? "").trim();
  return configured.length > 0 ? configured : DEFAULT_AGENT_MODEL;
}

type GeminiCall = (params: GeminiGenerateTextParams) => Promise<GeminiGenerateTextResult>;

export type AgentRunDeps = {
  /** Injectable Gemini call (tests). */
  generate?: GeminiCall;
};

export type AgentRunInput = {
  businessId: string;
  agent: {
    instructions: string;
    output_format: AgentOutputFormat;
  };
  /** Original filename, used for prompts + the artifact filename. */
  inputFilename: string;
  inputMime: string;
  /** Raw attachment bytes (text formats are decoded; PDFs attach inline). */
  data: Buffer;
};

export type AgentRunResult =
  | {
      ok: true;
      outputMd: string;
      outputFilename: string;
      outputMime: string;
      usage: GeminiUsage | null;
    }
  | {
      ok: false;
      error: "unsupported_type" | "empty_content" | "model_unavailable" | "model_failed";
      detail?: string;
    };

/**
 * Execute one agent run. Never throws for expected failures — the caller
 * persists the result (ok or not) onto the `agent_runs` row.
 */
export async function executeAgentRun(
  input: AgentRunInput,
  deps: AgentRunDeps = {}
): Promise<AgentRunResult> {
  /* c8 ignore next -- production default; tests inject generate */
  const generate = deps.generate ?? geminiGenerateTextDetailed;

  const mime = input.inputMime.trim().toLowerCase();
  const isText = (AGENT_TEXT_MIME_TYPES as readonly string[]).includes(mime);
  const isPdf = mime === AGENT_PDF_MIME_TYPE;
  if (!isText && !isPdf) return { ok: false, error: "unsupported_type" };

  const target = resolveOutputTarget(input.agent.output_format, mime);
  let prompt: string;
  let inlineParts: GeminiGenerateTextParams["inlineParts"];
  if (isText) {
    const decoded = input.data.toString("utf8").replace(/\u0000/g, "");
    const asText = mime === VTT_MIME_TYPE ? vttToPlainText(decoded) : decoded;
    const rawText = asText.trim().slice(0, AGENT_INPUT_MAX_TEXT_CHARS);
    if (rawText.length === 0) return { ok: false, error: "empty_content" };
    prompt = buildAgentRunPrompt({
      instructions: input.agent.instructions,
      inputFilename: input.inputFilename,
      formatWord: target.formatWord,
      inputText: rawText
    });
    inlineParts = undefined;
  } else {
    if (input.data.byteLength === 0) return { ok: false, error: "empty_content" };
    prompt = buildAgentRunPrompt({
      instructions: input.agent.instructions,
      inputFilename: input.inputFilename,
      formatWord: target.formatWord
    });
    inlineParts = [{ mimeType: AGENT_PDF_MIME_TYPE, dataBase64: input.data.toString("base64") }];
  }

  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) return { ok: false, error: "model_unavailable" };
  const model = resolveModel();
  const inputChars = AGENT_RUN_SYSTEM_PROMPT.length + prompt.length;
  const controller = new AbortController();
  /* c8 ignore next -- timer fires only on a real Gemini hang */
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const { text, usage } = await generate({
      apiKey,
      model,
      systemInstruction: AGENT_RUN_SYSTEM_PROMPT,
      userText: prompt,
      temperature: 0.2,
      // Transformations can legitimately be long (a full rewritten document);
      // billing is by actual tokens, the cap only prevents mid-artifact
      // truncation.
      maxOutputTokens: 16_000,
      ...(inlineParts ? { inlineParts } : {}),
      signal: controller.signal
    });
    await meterGeminiSpendForBusiness({
      businessId: input.businessId,
      model,
      surface: "agent_run",
      usage,
      inputChars,
      outputChars: text.length
    });
    const outputMd = normalizeAgentOutput(text);
    if (!outputMd) return { ok: false, error: "empty_content" };
    return {
      ok: true,
      outputMd,
      outputFilename: buildOutputFilename(input.inputFilename, target),
      outputMime: target.mime,
      usage
    };
  } catch (err) {
    if (err instanceof GeminiEmptyError) {
      // Billed even when empty (thinking-only output) — meter before failing.
      await meterGeminiSpendForBusiness({
        businessId: input.businessId,
        model,
        surface: "agent_run",
        usage: err.usage,
        inputChars,
        outputChars: 0
      });
    }
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("agents/run: model call failed", { businessId: input.businessId, error: detail });
    return { ok: false, error: "model_failed", detail };
  } finally {
    clearTimeout(timer);
  }
}
