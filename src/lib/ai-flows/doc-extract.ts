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
import {
  BUSINESS_DOCS_BUCKET,
  CONTACT_DOCUMENT_RECORDS_LIMIT,
  documentLimitForTier,
  parseExpirationInput,
  sanitizeRecordFields
} from "@/lib/documents/core";
import { countBusinessDocuments, insertBusinessDocument, patchBusinessDocument } from "@/lib/documents/db";
import { ingestDocument } from "@/lib/documents/ingest";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import { ingestDocRecordFields } from "@/lib/memory/graph-deterministic";
import { logger } from "@/lib/logger";
import { DOCX_MIME_TYPE, decodeDocxToText } from "@/lib/documents/docx";
import { resolveFlowDocumentSource } from "./doc-source";

// The ref-parsing primitives moved to doc-source (the shared resolver);
// re-exported here so existing importers keep working.
export {
  DOC_EXTRACT_MAX_BYTES,
  EMAIL_ATTACHMENTS_BUCKET,
  documentMimeForPath,
  parseDocumentRef
} from "./doc-source";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;
type GeminiCall = (params: GeminiGenerateTextParams) => Promise<GeminiGenerateTextResult>;

// gemini-3.5-flash-lite (GA Jul 21 2026): cheaper AND stronger than the old
// gemini-3-flash-preview default for structured document extraction.
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

export type DocExtractField = { name: string; description?: string };

export type DocExtractInput = {
  businessId: string;
  /**
   * Document ref: `email-attachments:<path>` (the trigger.document value)
   * or `business-docs:<documentId>` (a document already in the library —
   * including agent artifacts).
   */
  sourceRef: string;
  fields: DocExtractField[];
  /** File the document into Business Documents after extraction. */
  fileAs?: {
    title: string;
    audience: "clients" | "staff" | "both";
    /**
     * Link the filed document to the contact with this phone (record
     * layer). A literal already-resolved number; a lookup miss files
     * unlinked and reports a note.
     */
    contactPhone?: string;
    /**
     * Resolve the contact phone from THIS extraction's named field instead
     * (the document itself carries the customer's number).
     */
    contactPhoneField?: string;
    /** Stamp the extracted fields onto the record (record_fields jsonb). */
    recordFieldsFromExtraction?: boolean;
    /** Parse this extracted field as the record's renewal_date. */
    renewalDateField?: string;
  };
  businessName?: string;
};

export type DocExtractResult =
  | {
      ok: true;
      vars: Record<string, string>;
      filed: { documentId: string; title: string } | null;
      fileError?: string;
      /** Non-fatal filing observations (contact miss, unparseable renewal). */
      fileNotes?: string[];
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

  // Ref resolution + tenant-ownership gating live in the shared resolver
  // (doc-source): email-attachments refs pass the email_log containment
  // gate (fails closed; a transient lookup fault THROWS so the worker
  // retries); business-docs refs are gated by the tenant-scoped row lookup.
  const resolved = await resolveFlowDocumentSource(input.businessId, input.sourceRef, {
    client: db
  });
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error,
      ...(resolved.detail ? { detail: resolved.detail } : {})
    };
  }
  const { bytes, mimeType, filename } = resolved.source;

  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) return { ok: false, error: "extractor_unavailable" };
  const model = (process.env.GEMINI_SUMMARY_MODEL ?? "").trim() || DEFAULT_GEMINI_MODEL;

  const isPdf = mimeType === "application/pdf";
  const prompt = buildDocExtractionPrompt(input.fields);
  let docText = "";
  if (!isPdf) {
    // Word documents decode locally (Gemini reads PDFs natively, not DOCX);
    // an unreadable .docx is a permanent input problem, same as empty bytes.
    if (mimeType === DOCX_MIME_TYPE) {
      const decoded = await decodeDocxToText(bytes);
      if (decoded === null) {
        return { ok: false, error: "empty_document", detail: "unreadable Word document" };
      }
      docText = decoded;
    } else {
      docText = bytes.toString("utf8");
    }
  }
  const userText = isPdf
    ? prompt
    : `${prompt}\n\nDocument text:\n---\n${docText.slice(0, 40_000)}\n---`;
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
  const fileNotes: string[] = [];
  try {
    const { data: bizRow } = await db
      .from("businesses")
      .select("tier, name")
      .eq("id", input.businessId)
      .maybeSingle();
    const tier = (bizRow as { tier?: string | null } | null)?.tier ?? null;

    // ── Record sinks: resolve the structured extras BEFORE the insert so a
    // filed document lands complete (contact link, fields, renewal date).
    // Every sink is best-effort: a miss files the document anyway and
    // reports a note — the extraction the flow branches on already
    // succeeded, and an unlinked filed copy beats no copy.
    let contactId: string | null = null;
    let contactE164: string | null = null;
    const phoneRaw = (
      input.fileAs.contactPhoneField
        ? vars[input.fileAs.contactPhoneField] ?? ""
        : input.fileAs.contactPhone ?? ""
    ).trim();
    if (input.fileAs.contactPhone !== undefined || input.fileAs.contactPhoneField !== undefined) {
      if (!phoneRaw) {
        fileNotes.push("contact link skipped: no phone value");
      } else {
        const normalized = normalizeContactNumber(phoneRaw);
        if (!normalized.ok) {
          fileNotes.push(`contact link skipped: ${normalized.reason}`);
        } else {
          // Primary number OR merged-away alias — same match the records
          // CSV importer uses.
          const { data: contact, error: contactErr } = await db
            .from("contacts")
            .select("id")
            .eq("business_id", input.businessId)
            .or(`customer_e164.eq.${normalized.value},alias_e164s.cs.{${normalized.value}}`)
            .maybeSingle();
          if (contactErr) throw new Error(contactErr.message);
          if (!contact) {
            fileNotes.push(`contact link skipped: no contact with number ${normalized.value}`);
          } else {
            contactId = (contact as { id: string }).id;
            contactE164 = normalized.value;
          }
        }
      }
    }

    let recordFields: Record<string, string> | null = null;
    if (input.fileAs.recordFieldsFromExtraction) {
      recordFields = sanitizeRecordFields(vars);
      if (!recordFields) fileNotes.push("record fields skipped: nothing extracted");
    }

    let renewalDate: string | null = null;
    if (input.fileAs.renewalDateField) {
      const rawDate = (vars[input.fileAs.renewalDateField] ?? "").trim();
      renewalDate = rawDate ? parseExpirationInput(rawDate) : null;
      if (!renewalDate) {
        fileNotes.push(
          rawDate
            ? `renewal date skipped: "${rawDate.slice(0, 60)}" is not a date`
            : "renewal date skipped: field was empty"
        );
      }
    }

    // Contact-linked records count against the flat records cap (same pool
    // as the CSV book-of-business importer); unlinked filings stay under
    // the tier's library cap.
    if (contactId) {
      const count = await countBusinessDocuments(input.businessId, "contact_records", db);
      if (count >= CONTACT_DOCUMENT_RECORDS_LIMIT) {
        return {
          ok: true,
          vars,
          filed: null,
          fileError: "contact record limit reached",
          ...(fileNotes.length > 0 ? { fileNotes } : {})
        };
      }
    } else {
      const count = await countBusinessDocuments(input.businessId, "library", db);
      if (count >= documentLimitForTier(tier)) {
        return {
          ok: true,
          vars,
          filed: null,
          fileError: "document limit reached for your plan",
          ...(fileNotes.length > 0 ? { fileNotes } : {})
        };
      }
    }

    const documentId = crypto.randomUUID();
    const safeName =
      filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "document";
    const storagePath = `${input.businessId}/${documentId}/${safeName}`;
    const { error: uploadError } = await db.storage
      .from(BUSINESS_DOCS_BUCKET)
      .upload(storagePath, bytes, { contentType: mimeType });
    if (uploadError) {
      return {
        ok: true,
        vars,
        filed: null,
        fileError: `storage copy failed: ${uploadError.message}`,
        ...(fileNotes.length > 0 ? { fileNotes } : {})
      };
    }

    const title = input.fileAs.title.slice(0, 200);
    try {
      await insertBusinessDocument(
        {
          id: documentId,
          business_id: input.businessId,
          title,
          category: "filed",
          audience: input.fileAs.audience,
          storage_path: storagePath,
          mime_type: mimeType,
          byte_size: bytes.byteLength,
          ...(contactId ? { contact_id: contactId } : {}),
          ...(renewalDate ? { renewal_date: renewalDate } : {}),
          ...(recordFields ? { record_fields: recordFields } : {})
        },
        db
      );
    } catch (insertErr) {
      // Compensating remove (mirrors the dashboard upload route): a failed
      // insert must not orphan the just-uploaded object in the bucket.
      const { error: removeError } = await db.storage
        .from(BUSINESS_DOCS_BUCKET)
        .remove([storagePath]);
      if (removeError) {
        logger.warn("aiflows/doc-extract: orphan object cleanup failed", {
          businessId: input.businessId,
          storagePath,
          error: removeError.message
        });
      }
      throw insertErr;
    }

    // Knowledge graph (kg-source: doc_extract_fields): the typed
    // quote/contract fields become facts on the linked contact's node.
    // Never-throws, mode-gated inside; skipped without a linked contact
    // (no subject to attach facts to).
    if (recordFields && contactE164) {
      await ingestDocRecordFields(input.businessId, {
        title,
        fields: recordFields,
        contactName: null,
        contactE164
      });
    }

    // Same condense pipeline as dashboard uploads, so the filed copy answers
    // knowledge lookups. From here on the document EXISTS (row + bytes), so
    // any condense/patch failure still reports `filed` — downstream steps
    // can reference the copy while the owner re-ingests from the dashboard.
    try {
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
      return {
        ok: true,
        vars,
        filed: { documentId, title },
        ...(fileNotes.length > 0 ? { fileNotes } : {})
      };
    } catch (postInsertErr) {
      const detail = postInsertErr instanceof Error ? postInsertErr.message : String(postInsertErr);
      logger.warn("aiflows/doc-extract: post-filing condense failed", {
        businessId: input.businessId,
        documentId,
        error: detail
      });
      return {
        ok: true,
        vars,
        filed: { documentId, title },
        fileError: detail,
        ...(fileNotes.length > 0 ? { fileNotes } : {})
      };
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("aiflows/doc-extract: filing failed", { businessId: input.businessId, error: detail });
    return {
      ok: true,
      vars,
      filed: null,
      fileError: detail,
      ...(fileNotes.length > 0 ? { fileNotes } : {})
    };
  }
}
