/**
 * Flow document sources — resolve a templated document ref to bytes the
 * platform can hand to Gemini (agent runs, doc extraction).
 *
 * Two ref forms are addressable:
 *   - `email-attachments:<path>` — an inbound tenant-mailbox attachment
 *     ({{trigger.document}}). Ownership is gated on the path being recorded
 *     on THIS business's own inbound mail (email_log.attachments), exactly
 *     like doc-extract: the ref came through a template render, so it is
 *     untrusted.
 *   - `business-docs:<documentId>` — a document in the business's own
 *     Documents store. Ownership is the tenant-scoped row lookup itself;
 *     only ready documents with a supported original format resolve.
 *
 * Failure taxonomy matches doc-extract: `ok:false` errors are PERMANENT
 * input problems (bad ref, unsupported type, oversized, missing) — callers
 * report them without retrying; thrown errors are transient lookup/storage
 * faults the worker retries.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusinessDocument } from "@/lib/documents/db";
import { BUSINESS_DOCS_BUCKET } from "@/lib/documents/core";
import { isSupportedDocumentMime } from "@/lib/documents/ingest";
import { DOCX_MIME_TYPE } from "@/lib/documents/docx";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Bucket the tenant-mailbox email worker stores inbound attachments in. */
export const EMAIL_ATTACHMENTS_BUCKET = "email-attachments";
/** Inline-data ceiling (Gemini's request cap is ~20 MB; leave headroom). */
export const DOC_EXTRACT_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Parse and sanitize an email-attachment document ref. Only sane relative
 * paths within the email-attachments bucket — the ref came through a
 * template render, so treat it as untrusted.
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
  if (ext === "docx") return DOCX_MIME_TYPE;
  return TEXT_EXTENSIONS[ext] ?? "";
}

const BUSINESS_DOC_REF_RE =
  /^business-docs:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export type FlowDocumentSource = {
  bytes: Buffer;
  mimeType: string;
  /** Display filename (prompt + run-history labels). */
  filename: string;
  /** business_documents id when the ref was a business-docs ref. */
  documentId: string | null;
};

export type FlowDocumentSourceResult =
  | { ok: true; source: FlowDocumentSource }
  | {
      ok: false;
      error: "unsupported_ref" | "unsupported_type" | "too_large" | "not_found" | "empty_document";
      detail?: string;
    };

/** The stored filename part of a ref path (email worker prefixes "0-name.pdf"). */
function fileNameOfPath(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1].replace(/^\d+-/, "");
}

export type ResolveFlowDocumentOpts = {
  client?: SupabaseClient;
  /** Inline-data ceiling; defaults to the doc-extract cap. */
  maxBytes?: number;
};

/**
 * Resolve a rendered document ref to its bytes, gated to the business's own
 * material. See the module doc for the ref forms and failure taxonomy.
 */
export async function resolveFlowDocumentSource(
  businessId: string,
  ref: string,
  opts: ResolveFlowDocumentOpts = {}
): Promise<FlowDocumentSourceResult> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const maxBytes = opts.maxBytes ?? DOC_EXTRACT_MAX_BYTES;
  const trimmed = ref.trim();

  const businessDocMatch = BUSINESS_DOC_REF_RE.exec(trimmed);
  if (businessDocMatch) {
    // Tenant scoping IS the ownership gate: the lookup is keyed on this
    // business's id, so another tenant's document id reads as missing.
    const document = await getBusinessDocument(businessId, businessDocMatch[1], db);
    if (!document) {
      return { ok: false, error: "not_found", detail: "document not in this business's Documents" };
    }
    if (document.status !== "ready") {
      return { ok: false, error: "not_found", detail: "document is not ready to use" };
    }
    const mimeType = document.mime_type.trim().toLowerCase();
    if (!isSupportedDocumentMime(mimeType)) {
      return {
        ok: false,
        error: "unsupported_type",
        detail: "only pdf/docx/txt/md/csv/vtt documents"
      };
    }
    const { data: blob, error: downloadError } = await db.storage
      .from(BUSINESS_DOCS_BUCKET)
      .download(document.storage_path);
    if (downloadError || !blob) {
      return {
        ok: false,
        error: "not_found",
        detail: downloadError?.message ?? "document missing from storage"
      };
    }
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (bytes.byteLength === 0) return { ok: false, error: "empty_document" };
    if (bytes.byteLength > maxBytes) {
      return { ok: false, error: "too_large", detail: `${bytes.byteLength} bytes` };
    }
    return {
      ok: true,
      source: {
        bytes,
        mimeType,
        filename: fileNameOfPath(document.storage_path) || document.title,
        documentId: document.id
      }
    };
  }

  const attachmentRef = parseDocumentRef(trimmed);
  if (!attachmentRef) {
    return { ok: false, error: "unsupported_ref", detail: "unrecognized document ref" };
  }
  const mimeType = documentMimeForPath(attachmentRef.path);
  if (!mimeType) {
    return { ok: false, error: "unsupported_type", detail: "only pdf/docx/txt/md/csv documents" };
  }

  // Ownership gate (same shape as doc-extract): fails CLOSED on "no such
  // row" and THROWS on a lookup fault (transient → the caller retries; a
  // fail-open here would be a cross-tenant read).
  const { data: ownerRow, error: ownErr } = await db
    .from("email_log")
    .select("id")
    .eq("business_id", businessId)
    .contains("attachments", [{ storage_path: attachmentRef.path }])
    .limit(1)
    .maybeSingle();
  if (ownErr) throw new Error(`doc-source ownership lookup: ${ownErr.message}`);
  if (!ownerRow) {
    return { ok: false, error: "not_found", detail: "document not on this business's mailbox" };
  }

  const { data: blob, error: downloadError } = await db.storage
    .from(attachmentRef.bucket)
    .download(attachmentRef.path);
  if (downloadError || !blob) {
    return {
      ok: false,
      error: "not_found",
      detail: downloadError?.message ?? "document missing from storage"
    };
  }
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.byteLength === 0) return { ok: false, error: "empty_document" };
  if (bytes.byteLength > maxBytes) {
    return { ok: false, error: "too_large", detail: `${bytes.byteLength} bytes` };
  }
  return {
    ok: true,
    source: {
      bytes,
      mimeType,
      filename: fileNameOfPath(attachmentRef.path),
      documentId: null
    }
  };
}
