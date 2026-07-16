/**
 * Business Documents — upload ingestion (extract + condense).
 *
 * Text formats (txt / markdown / csv) are decoded directly; PDFs go to
 * Gemini as inlineData (native PDF understanding — no local parser
 * dependency). Either way one Gemini pass condenses the material into the
 * agent-facing `content_md` plus a 1–2 sentence retrieval `summary`,
 * mirroring the website-ingest pipeline (metered into the shared AI budget
 * via meterGeminiSpendForBusiness).
 */

import {
  GeminiEmptyError,
  geminiGenerateTextDetailed,
  type GeminiGenerateTextParams,
  type GeminiGenerateTextResult
} from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { logger } from "@/lib/logger";
import { DOCUMENT_CONTENT_MD_MAX_CHARS, DOCUMENT_SUMMARY_MAX_CHARS } from "./core";
import { VTT_MIME_TYPE, isVttUpload, vttToPlainText } from "@/lib/transcripts/vtt";

/** Raw text fed to the condenser is clipped to keep the prompt bounded. */
export const DOCUMENT_INGEST_MAX_TEXT_CHARS = 40_000;

export const DOCUMENT_TEXT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  // Meeting transcripts (Zoom/Meet/Teams recordings). Converted from cue
  // soup to "Speaker: sentence" lines before condensing.
  VTT_MIME_TYPE
] as const;
export const DOCUMENT_PDF_MIME_TYPE = "application/pdf";
export const DOCUMENT_ALLOWED_MIME_TYPES = [
  ...DOCUMENT_TEXT_MIME_TYPES,
  DOCUMENT_PDF_MIME_TYPE
] as const;

export function isSupportedDocumentMime(mime: string): boolean {
  return (DOCUMENT_ALLOWED_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * Canonical mime for an upload: maps VTT transcripts (reported as text/vtt,
 * blank, or octet-stream with a .vtt name — browsers do all three) onto
 * VTT_MIME_TYPE so the upload routes accept them and ingestion knows to
 * convert. Every other upload keeps its reported type.
 */
export function normalizeUploadMime(mime: string, filename: string): string {
  const trimmed = mime.trim().toLowerCase();
  return isVttUpload(trimmed, filename) ? VTT_MIME_TYPE : trimmed;
}

const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";

function resolveModel(): string {
  const configured = (process.env.GEMINI_SUMMARY_MODEL ?? "").trim();
  return configured.length > 0 ? configured : DEFAULT_GEMINI_MODEL;
}

type GeminiCall = (params: GeminiGenerateTextParams) => Promise<GeminiGenerateTextResult>;

export type DocumentIngestDeps = {
  /** Injectable Gemini call (tests). */
  generate?: GeminiCall;
};

export type DocumentIngestInput = {
  businessId: string;
  title: string;
  mimeType: string;
  /** Raw uploaded bytes. */
  data: Buffer;
  businessName?: string;
};

export type DocumentIngestResult =
  | { ok: true; contentMd: string; summary: string }
  | {
      ok: false;
      error: "unsupported_type" | "empty_content" | "summarizer_unavailable" | "summarizer_failed";
      detail?: string;
    };

const CONDENSE_SYSTEM_PROMPT =
  "You convert small-business documents into concise, accurate markdown an AI receptionist will answer customer questions from. Preserve every concrete fact: prices, durations, policies, dates, names, contact info. Never invent facts.";

function buildCondensePrompt(args: {
  title: string;
  businessName?: string;
  rawText?: string;
}): string {
  const lines = [
    `Condense the business document "${args.title}"${
      args.businessName ? ` from ${args.businessName}` : ""
    } into agent-ready markdown.`,
    "",
    "Reply in EXACTLY this layout:",
    "SUMMARY: <one or two sentences describing what this document covers>",
    "---",
    "<clean markdown with every concrete fact from the document — prices, durations, policies, dates. Prefer bullet points. No preamble.>"
  ];
  if (args.rawText !== undefined) {
    lines.push("", "Document text (may be truncated):", "---", args.rawText, "---");
  } else {
    lines.push("", "The document file is attached.");
  }
  return lines.join("\n");
}

/**
 * Split the model's "SUMMARY: ...\n---\n<markdown>" layout. Tolerant: when
 * the delimiter is missing the whole reply becomes the content and the
 * summary falls back to its first line.
 */
export function parseCondensedReply(reply: string): { contentMd: string; summary: string } {
  // The content group is optional so a reply whose body is blank (delimiter
  // at end-of-string) still parses — and correctly yields empty content.
  const match = /^SUMMARY:\s*([\s\S]*?)\n-{3,}(?:\n([\s\S]*))?$/m.exec(reply.trim());
  if (match) {
    const summary = match[1].replace(/\s+/g, " ").trim().slice(0, DOCUMENT_SUMMARY_MAX_CHARS);
    const contentMd = (match[2] ?? "").trim().slice(0, DOCUMENT_CONTENT_MD_MAX_CHARS);
    return { contentMd, summary };
  }
  const fallback = reply.trim();
  const firstLine = fallback.split("\n")[0].replace(/^SUMMARY:\s*/i, "").trim();
  return {
    contentMd: fallback.slice(0, DOCUMENT_CONTENT_MD_MAX_CHARS),
    summary: firstLine.slice(0, DOCUMENT_SUMMARY_MAX_CHARS)
  };
}

async function runCondense(
  businessId: string,
  systemInstruction: string,
  prompt: string,
  inlineParts: GeminiGenerateTextParams["inlineParts"],
  generate: GeminiCall,
  surface: string
): Promise<{ ok: true; text: string } | { ok: false; error: "summarizer_unavailable" | "summarizer_failed"; detail?: string }> {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) return { ok: false, error: "summarizer_unavailable" };
  const model = resolveModel();
  const inputChars = systemInstruction.length + prompt.length;
  const controller = new AbortController();
  /* c8 ignore next -- timer fires only on a real Gemini hang */
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const { text, usage } = await generate({
      apiKey,
      model,
      systemInstruction,
      userText: prompt,
      temperature: 0.2,
      maxOutputTokens: 3000,
      ...(inlineParts && inlineParts.length > 0 ? { inlineParts } : {}),
      signal: controller.signal
    });
    await meterGeminiSpendForBusiness({
      businessId,
      model,
      surface,
      usage,
      inputChars,
      outputChars: text.length
    });
    return { ok: true, text };
  } catch (err) {
    if (err instanceof GeminiEmptyError) {
      // Billed even when empty (thinking-only output) — meter before failing.
      await meterGeminiSpendForBusiness({
        businessId,
        model,
        surface,
        usage: err.usage,
        inputChars,
        outputChars: 0
      });
    }
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("documents/ingest: condense failed", { businessId, surface, error: detail });
    return { ok: false, error: "summarizer_failed", detail };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract + condense an uploaded document into `content_md` + `summary`.
 */
export async function ingestDocument(
  input: DocumentIngestInput,
  deps: DocumentIngestDeps = {}
): Promise<DocumentIngestResult> {
  /* c8 ignore next -- production default; tests inject generate */
  const generate = deps.generate ?? geminiGenerateTextDetailed;

  if ((DOCUMENT_TEXT_MIME_TYPES as readonly string[]).includes(input.mimeType)) {
    const decoded = input.data.toString("utf8").replace(/\u0000/g, "");
    // VTT transcripts become "Speaker: sentence" lines so the condenser
    // reads a meeting, not subtitle cue soup.
    const asText = input.mimeType === VTT_MIME_TYPE ? vttToPlainText(decoded) : decoded;
    const rawText = asText.trim().slice(0, DOCUMENT_INGEST_MAX_TEXT_CHARS);
    if (rawText.length < 20) return { ok: false, error: "empty_content" };
    const prompt = buildCondensePrompt({
      title: input.title,
      businessName: input.businessName,
      rawText
    });
    const result = await runCondense(
      input.businessId,
      CONDENSE_SYSTEM_PROMPT,
      prompt,
      undefined,
      generate,
      "document_ingest"
    );
    if (!result.ok) return result;
    const parsed = parseCondensedReply(result.text);
    if (!parsed.contentMd) return { ok: false, error: "empty_content" };
    return { ok: true, ...parsed };
  }

  if (input.mimeType === DOCUMENT_PDF_MIME_TYPE) {
    if (input.data.byteLength === 0) return { ok: false, error: "empty_content" };
    const prompt = buildCondensePrompt({ title: input.title, businessName: input.businessName });
    const result = await runCondense(
      input.businessId,
      CONDENSE_SYSTEM_PROMPT,
      prompt,
      [{ mimeType: DOCUMENT_PDF_MIME_TYPE, dataBase64: input.data.toString("base64") }],
      generate,
      "document_ingest"
    );
    if (!result.ok) return result;
    const parsed = parseCondensedReply(result.text);
    if (!parsed.contentMd) return { ok: false, error: "empty_content" };
    return { ok: true, ...parsed };
  }

  return { ok: false, error: "unsupported_type" };
}

export type DocumentRewriteResult =
  | { ok: true; contentMd: string; summary: string }
  | { ok: false; error: "summarizer_unavailable" | "summarizer_failed"; detail?: string };

const REWRITE_SYSTEM_PROMPT =
  "You maintain a small business's knowledge documents. Apply the owner's requested edit to the markdown document exactly — change only what the edit requires, keep every other fact byte-identical. Never invent facts.";

/**
 * Apply a free-form owner edit ("haircuts are now $40") to a document's
 * agent-facing markdown. Used by the dashboard-only document_update tool;
 * the original uploaded file is immutable, edits apply to `content_md`.
 */
export async function rewriteDocumentContent(
  args: {
    businessId: string;
    title: string;
    currentContentMd: string;
    instruction: string;
  },
  deps: DocumentIngestDeps = {}
): Promise<DocumentRewriteResult> {
  /* c8 ignore next -- production default; tests inject generate */
  const generate = deps.generate ?? geminiGenerateTextDetailed;
  const prompt = [
    `Document title: ${args.title}`,
    "",
    "Requested edit:",
    args.instruction.trim(),
    "",
    "Reply in EXACTLY this layout:",
    "SUMMARY: <one or two sentences describing what the updated document covers>",
    "---",
    "<the FULL updated markdown document>",
    "",
    "Current document:",
    "---",
    args.currentContentMd.slice(0, DOCUMENT_INGEST_MAX_TEXT_CHARS),
    "---"
  ].join("\n");
  const result = await runCondense(
    args.businessId,
    REWRITE_SYSTEM_PROMPT,
    prompt,
    undefined,
    generate,
    "document_update"
  );
  if (!result.ok) return result;
  const parsed = parseCondensedReply(result.text);
  return { ok: true, ...parsed };
}
