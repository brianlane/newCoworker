/**
 * AiFlow `doc_extract` — the platform side (Node): download the referenced
 * document, run Gemini's native document understanding to pull the flow's
 * typed fields out of it, and optionally FILE it into Business Documents
 * (condensed through the same ingest pipeline as dashboard uploads, so the
 * filed copy is retrievable via business_knowledge_lookup and shareable via
 * share_document).
 *
 * Called by /api/internal/aiflow-doc-extract (gateway-guarded) on behalf of
 * the ai-flow-worker — the worker can't reach Gemini's document pipeline or
 * the documents store from the edge runtime, mirroring the email_extract
 * mailbox proxy.
 *
 * Failure taxonomy (drives the worker's retry decision):
 *   - ok:false errors are PERMANENT input problems (bad ref, unsupported
 *     type, oversized, unreadable) — the worker fails the step, no retry;
 *   - thrown errors are transient (storage/model transport) — the route 500s
 *     and the worker retries;
 *   - a FILING failure is non-fatal (`fileError`): the extraction the flow
 *     branches on already succeeded, and the owner can re-file by hand.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  GeminiEmptyError,
  geminiGenerateTextDetailed,
  type GeminiGenerateTextParams,
  type GeminiGenerateTextResult
} from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { BUSINESS_DOCS_BUCKET, documentLimitForTier } from "@/lib/documents/core";
import { countBusinessDocuments, insertBusinessDocument, patchBusinessDocument } from "@/lib/documents/db";
import { ingestDocument } from "@/lib/documents/ingest";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;
type GeminiCall = (params: GeminiGenerateTextParams) => Promise<GeminiGenerateTextResult>;

/** Bucket the tenant-mailbox email worker stores inbound attachments in. */
export const EMAIL_ATTACHMENTS_BUCKET = "email-attachments";
/** Inline-data ceiling (Gemini's request cap is ~20 MB; leave headroom). */
export const DOC_EXTRACT_MAX_BYTES = 15 * 1024 * 1024;

const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";

export type DocExtractField = { name: string; description?: string };

export type DocExtractInput = {
  businessId: string;
  /** `email-attachments:<path>` ref (the trigger.document value). */
  sourceRef: string;
  fields: DocExtractField[];
  /** File the document into Business Documents after extraction. */
  fileAs?: { title: string; audience: "clients" | "staff" | "both" };
  businessName?: string;
};

export type DocExtractResult =
  | {
      ok: true;
      vars: Record<string, string>;
      filed: { documentId: string; title: string } | null;
      fileError?: string;
    }
  | {
      ok: false;
      error:
        | "unsupported_ref"
        | "unsupported_type"
        | "too_large"
        | "not_found"
        | "empty_document"
        | "extractor_unavailable"
        | "extraction_failed";
      detail?: string;
    };

export type DocExtractDeps = {
  client?: SupabaseClient;
  /** Injectable Gemini call (tests). */
  generate?: GeminiCall;
};

/**
 * Parse and sanitize a document ref. Only the email-attachments bucket is
 * addressable, and only sane relative paths within it — the ref came through
 * a template render, so treat it as untrusted.
 */
export function parseDocumentRef(ref: string): { bucket: string; path: string } | null {
  const match = /^email-attachments:(.+)$/.exec(ref.trim());
  if (!match) return null;
  const path = match[1];
  if (path.length === 0 || path.length > 500) return null;
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) return null;
  return { bucket: EMAIL_ATTACHMENTS_BUCKET, path };
}

const TEXT_EXTENSIONS: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv"
};

/** Infer the document MIME from the stored filename ("" = unsupported). */
export function documentMimeForPath(path: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? "").toLowerCase();
  if (ext === "pdf") return "application/pdf";
  return TEXT_EXTENSIONS[ext] ?? "";
}

/** Prompt: return EXACTLY one JSON object with the requested fields. */
export function buildDocExtractionPrompt(fields: DocExtractField[]): string {
  const lines = [
    "Read the attached/business document and extract these fields.",
    'Reply with EXACTLY one JSON object — no prose, no code fences — of the shape:',
    "{",
    ...fields.map(
      (f) =>
        `  ${JSON.stringify(f.name)}: "<${f.description?.trim() || f.name}; empty string if absent>"`
    ),
    "}",
    "Every value must be a string; never invent values not present in the document."
  ];
  return lines.join("\n");
}

/** Tolerant JSON pick: fences stripped, only the requested string fields kept. */
export function parseDocExtractionReply(
  reply: string,
  fields: DocExtractField[]
): Record<string, string> | null {
  const stripped = reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const f of fields) {
      const v = parsed[f.name];
      out[f.name] = typeof v === "string" ? v.trim().slice(0, 2000) : "";
    }
    return out;
  } catch {
    return null;
  }
}

/** The stored filename part of a ref path (for default filing titles). */
function fileNameOfPath(path: string): string {
  const parts = path.split("/");
  const last = parts[parts.length - 1];
  // The email worker prefixes attachment files with their index ("0-name.pdf").
  return last.replace(/^\d+-/, "");
}

/**
 * Download → extract → (optionally) file. See the module doc for the
 * failure taxonomy.
 */
export async function docExtract(
  input: DocExtractInput,
  deps: DocExtractDeps = {}
): Promise<DocExtractResult> {
  const db = deps.client ?? (await createSupabaseServiceClient());
  /* c8 ignore next -- production default; tests inject generate */
  const generate = deps.generate ?? geminiGenerateTextDetailed;

  const ref = parseDocumentRef(input.sourceRef);
  if (!ref) return { ok: false, error: "unsupported_ref", detail: "unrecognized document ref" };
  const mimeType = documentMimeForPath(ref.path);
  if (!mimeType) {
    return { ok: false, error: "unsupported_type", detail: "only pdf/txt/md/csv documents" };
  }

  const { data: blob, error: downloadError } = await db.storage
    .from(ref.bucket)
    .download(ref.path);
  if (downloadError || !blob) {
    // Storage 404s are permanent (a pruned/retention-deleted attachment will
    // never come back); other failures could be transient, but the client
    // does not distinguish them — treat the read as permanent and let the
    // owner re-send the document rather than retry-looping the run.
    return {
      ok: false,
      error: "not_found",
      detail: downloadError?.message ?? "document missing from storage"
    };
  }
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.byteLength === 0) return { ok: false, error: "empty_document" };
  if (bytes.byteLength > DOC_EXTRACT_MAX_BYTES) {
    return { ok: false, error: "too_large", detail: `${bytes.byteLength} bytes` };
  }

  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) return { ok: false, error: "extractor_unavailable" };
  const model = (process.env.GEMINI_SUMMARY_MODEL ?? "").trim() || DEFAULT_GEMINI_MODEL;

  const isPdf = mimeType === "application/pdf";
  const prompt = buildDocExtractionPrompt(input.fields);
  const userText = isPdf
    ? prompt
    : `${prompt}\n\nDocument text:\n---\n${bytes.toString("utf8").slice(0, 40_000)}\n---`;
  const systemInstruction =
    "You extract precise facts from business documents (policies, renewal notices, invoices, statements). You reply with exactly the JSON object requested and never invent values.";

  let text: string;
  try {
    const result = await generate({
      apiKey,
      model,
      systemInstruction,
      userText,
      temperature: 0,
      maxOutputTokens: 1500,
      ...(isPdf
        ? { inlineParts: [{ mimeType, dataBase64: bytes.toString("base64") }] }
        : {})
    });
    text = result.text;
    await meterGeminiSpendForBusiness({
      businessId: input.businessId,
      model,
      surface: "aiflow_doc_extract",
      usage: result.usage,
      inputChars: systemInstruction.length + userText.length,
      outputChars: text.length
    });
  } catch (err) {
    if (err instanceof GeminiEmptyError) {
      // Billed even when empty (thinking-only output) — meter before failing.
      await meterGeminiSpendForBusiness({
        businessId: input.businessId,
        model,
        surface: "aiflow_doc_extract",
        usage: err.usage,
        inputChars: systemInstruction.length + userText.length,
        outputChars: 0
      });
      return { ok: false, error: "extraction_failed", detail: "empty model reply" };
    }
    // Transport/model faults are transient — throw so the route 500s and the
    // worker retries.
    throw err;
  }

  const vars = parseDocExtractionReply(text, input.fields);
  if (!vars) {
    return { ok: false, error: "extraction_failed", detail: "unparseable model reply" };
  }

  if (!input.fileAs) return { ok: true, vars, filed: null };

  // ── Filing (non-fatal) ────────────────────────────────────────────────────
  try {
    const { data: bizRow } = await db
      .from("businesses")
      .select("tier, name")
      .eq("id", input.businessId)
      .maybeSingle();
    const tier = (bizRow as { tier?: string | null } | null)?.tier ?? null;
    // Filed flow documents live in the LIBRARY scope (no contact linkage),
    // so the library cap is the one that applies.
    const count = await countBusinessDocuments(input.businessId, "library", db);
    if (count >= documentLimitForTier(tier)) {
      return { ok: true, vars, filed: null, fileError: "document limit reached for your plan" };
    }

    const documentId = crypto.randomUUID();
    // The mime gate above guarantees an extension-bearing filename, so the
    // sanitized name can never be empty here.
    const safeName = fileNameOfPath(ref.path).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
    const storagePath = `${input.businessId}/${documentId}/${safeName}`;
    const { error: uploadError } = await db.storage
      .from(BUSINESS_DOCS_BUCKET)
      .upload(storagePath, bytes, { contentType: mimeType });
    if (uploadError) {
      return { ok: true, vars, filed: null, fileError: `storage copy failed: ${uploadError.message}` };
    }

    const title = input.fileAs.title.slice(0, 200);
    await insertBusinessDocument(
      {
        id: documentId,
        business_id: input.businessId,
        title,
        category: "filed",
        audience: input.fileAs.audience,
        storage_path: storagePath,
        mime_type: mimeType,
        byte_size: bytes.byteLength
      },
      db
    );

    // Same condense pipeline as dashboard uploads, so the filed copy answers
    // knowledge lookups. An ingest failure leaves the row visible as failed
    // (the owner can re-ingest from the dashboard) — the filing still stands.
    const ingested = await ingestDocument(
      {
        businessId: input.businessId,
        title,
        mimeType,
        data: bytes,
        businessName: (bizRow as { name?: string | null } | null)?.name ?? undefined
      },
      { generate }
    );
    if (ingested.ok) {
      await patchBusinessDocument(
        input.businessId,
        documentId,
        { content_md: ingested.contentMd, summary: ingested.summary, status: "ready", error_detail: null },
        db
      );
    } else {
      await patchBusinessDocument(
        input.businessId,
        documentId,
        { status: "failed", error_detail: ingested.detail ?? ingested.error },
        db
      );
    }
    return { ok: true, vars, filed: { documentId, title } };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("aiflows/doc-extract: filing failed", { businessId: input.businessId, error: detail });
    return { ok: true, vars, filed: null, fileError: detail };
  }
}
