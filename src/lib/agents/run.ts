/**
 * Agents — run executor.
 *
 * One agent run = one Gemini transformation: the agent's saved instructions
 * applied to one or MORE attachments (decoded text for txt/md/csv, native
 * inlineData for PDFs — same split as documents/ingest.ts). Multi-file runs
 * exist for side-by-side work ("compare these carrier quotes"): every text
 * file becomes a labeled prompt section and every PDF an inlineData part,
 * all in one model call. Caller-agnostic by design: the dashboard run route
 * and the run_agent AiFlow step both call `executeAgentRun`. Every call
 * (including billed-but-empty replies) is metered into the shared AI budget
 * under the `agent_run` surface.
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
  AGENT_RUN_MAX_FILES,
  AGENT_RUN_SYSTEM_PROMPT,
  buildAgentRunPrompt,
  buildOutputFilename,
  normalizeAgentOutput,
  resolveOutputTarget,
  type AgentOutputFormat,
  type AgentPromptTextSection
} from "./core";
import { VTT_MIME_TYPE, vttToPlainText } from "@/lib/transcripts/vtt";
import { DOCX_MIME_TYPE, decodeDocxToText } from "@/lib/documents/docx";
import { ensureHtmlDocument, sanitizeRetypesetHtml } from "./retypeset";

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
/** Word documents are decoded locally too (no native Gemini DOCX support). */
export const AGENT_DOCX_MIME_TYPE = DOCX_MIME_TYPE;

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

/** One additional attachment for a multi-file run. */
export type AgentRunExtraFile = {
  filename: string;
  mime: string;
  data: Buffer;
};

export type AgentRunInput = {
  businessId: string;
  agent: {
    instructions: string;
    output_format: AgentOutputFormat;
  };
  /** First (primary) filename — drives prompts + the artifact filename. */
  inputFilename: string;
  inputMime: string;
  /** Raw attachment bytes (text formats are decoded; PDFs attach inline). */
  data: Buffer;
  /**
   * Additional attachments transformed in the SAME model call ("compare
   * these quotes"). The primary file stays first; output format/filename
   * still follow it.
   */
  extraFiles?: AgentRunExtraFile[];
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
      error:
        | "unsupported_type"
        | "empty_content"
        | "too_many_files"
        | "model_unavailable"
        | "model_failed";
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

  const files: AgentRunExtraFile[] = [
    { filename: input.inputFilename, mime: input.inputMime, data: input.data },
    ...(input.extraFiles ?? [])
  ];
  if (files.length > AGENT_RUN_MAX_FILES) {
    return { ok: false, error: "too_many_files", detail: `${files.length} files` };
  }

  // Re-typeset mode reconstructs ONE source document's design, so it takes
  // exactly one PDF/Word input (Word decodes to text, so fidelity is
  // reduced — the model rebuilds layout from styling cues).
  const isRetypeset = input.agent.output_format === "pdf_retypeset";
  if (isRetypeset) {
    if (files.length > 1) {
      return {
        ok: false,
        error: "too_many_files",
        detail: "re-typesetting works on one source document"
      };
    }
    const primaryMime = input.inputMime.trim().toLowerCase();
    if (primaryMime !== AGENT_PDF_MIME_TYPE && primaryMime !== AGENT_DOCX_MIME_TYPE) {
      return {
        ok: false,
        error: "unsupported_type",
        detail: "re-typesetting needs a PDF or Word source document"
      };
    }
  }

  // Classify + decode every attachment before any model work: one bad file
  // fails the run up front (predictable — same contract as single-file).
  const textSections: AgentPromptTextSection[] = [];
  const pdfParts: NonNullable<GeminiGenerateTextParams["inlineParts"]> = [];
  const pdfNames: string[] = [];
  // Shared text budget across the run so a 5-file compare stays bounded the
  // same way one big file does.
  let remainingTextChars = AGENT_INPUT_MAX_TEXT_CHARS;
  for (const file of files) {
    const mime = file.mime.trim().toLowerCase();
    const isText = (AGENT_TEXT_MIME_TYPES as readonly string[]).includes(mime);
    const isPdf = mime === AGENT_PDF_MIME_TYPE;
    const isDocx = mime === AGENT_DOCX_MIME_TYPE;
    if (!isText && !isPdf && !isDocx) {
      return { ok: false, error: "unsupported_type", detail: file.filename };
    }
    if (isPdf) {
      if (file.data.byteLength === 0) {
        return { ok: false, error: "empty_content", detail: file.filename };
      }
      pdfParts.push({ mimeType: AGENT_PDF_MIME_TYPE, dataBase64: file.data.toString("base64") });
      pdfNames.push(file.filename);
      continue;
    }
    let asText: string;
    if (isDocx) {
      // Locally decoded — an unreadable/blank Word file is an input problem.
      asText = (await decodeDocxToText(file.data)) ?? "";
    } else {
      const decoded = file.data.toString("utf8").replace(/\u0000/g, "");
      asText = mime === VTT_MIME_TYPE ? vttToPlainText(decoded) : decoded;
    }
    const rawText = asText.trim();
    if (rawText.length === 0) {
      return { ok: false, error: "empty_content", detail: file.filename };
    }
    // Emptiness was checked on the FULL text; clipping to an exhausted
    // budget just drops the tail sections from the prompt.
    const clipped = rawText.slice(0, Math.max(0, remainingTextChars));
    remainingTextChars -= clipped.length;
    if (clipped.length > 0) textSections.push({ filename: file.filename, text: clipped });
  }

  // Output format/filename follow the PRIMARY (first) file, matching the
  // single-file behavior.
  const target = resolveOutputTarget(
    input.agent.output_format,
    input.inputMime.trim().toLowerCase()
  );
  const prompt = buildAgentRunPrompt({
    instructions: input.agent.instructions,
    formatWord: target.formatWord,
    textSections,
    attachedFilenames: pdfNames
  });
  const inlineParts = pdfParts.length > 0 ? pdfParts : undefined;

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
    const normalized = normalizeAgentOutput(text);
    if (!normalized) return { ok: false, error: "empty_content" };
    // Re-typeset artifacts are sanitized (scripts/external refs stripped —
    // the sidecar also disables JS and denies network) and guaranteed to be
    // a full HTML document so the byte renderers can sniff them.
    const outputMd = isRetypeset
      ? ensureHtmlDocument(sanitizeRetypesetHtml(normalized))
      : normalized;
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
