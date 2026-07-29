/**
 * Shared Zoom transcript-import pipeline, the single implementation behind
 * BOTH entry points:
 *
 *   - the owner-initiated import (POST /api/integrations/zoom/import-transcript);
 *   - the recording.transcript_completed webhook auto-import
 *     (src/lib/zoom/webhook.ts).
 *
 * One VTT in, one staff-only `meeting`-category document out: store the
 * original in the private bucket, insert the document row (tier cap
 * enforced, with the same serial post-insert re-check as the documents
 * upload route), condense to minutes via ingestDocument, re-sync the VPS
 * vault. Extracted from the route in Jul 2026 so the manual and automatic
 * paths cannot drift.
 */
import { randomUUID } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  countBusinessDocuments,
  deleteBusinessDocument,
  insertBusinessDocument,
  patchBusinessDocument,
  type BusinessDocumentRow
} from "@/lib/documents/db";
import { BUSINESS_DOCS_BUCKET, documentLimitForTier } from "@/lib/documents/core";
import { ingestDocument } from "@/lib/documents/ingest";
import { VTT_MIME_TYPE } from "@/lib/transcripts/vtt";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";
import { logger } from "@/lib/logger";

// Same ceiling as POST /api/dashboard/documents, an imported transcript
// must not exceed what a manual upload of the same VTT would be allowed.
export const MAX_ZOOM_TRANSCRIPT_BYTES = 10 * 1024 * 1024;

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ImportZoomTranscriptParams = {
  businessId: string;
  /** Business row fields the pipeline needs (caller already fetched it). */
  business: { name: string; tier: Parameters<typeof documentLimitForTier>[0] };
  /** Raw WebVTT text (already validated as VTT by the fetcher). */
  vtt: string;
  /** Document title, e.g. "Zoom meeting 1784344402882 (transcript)". */
  title: string;
  /** Filename-safe label for the stored object. */
  refLabel: string;
};

export type ImportZoomTranscriptDeps = {
  client?: SupabaseClient;
  countDocuments?: typeof countBusinessDocuments;
  insertDocument?: typeof insertBusinessDocument;
  patchDocument?: typeof patchBusinessDocument;
  deleteDocument?: typeof deleteBusinessDocument;
  ingest?: typeof ingestDocument;
  syncVault?: typeof syncVaultToVpsAndLog;
  uuid?: () => string;
};

export type ImportZoomTranscriptResult =
  | {
      ok: true;
      document: BusinessDocumentRow;
      status: "ready" | "failed";
      errorDetail: string | null;
      summary: string | null;
    }
  | {
      ok: false;
      error: "limit_reached" | "too_large" | "storage_failed";
      detail: string;
    };

export async function importZoomTranscriptDocument(
  params: ImportZoomTranscriptParams,
  deps: ImportZoomTranscriptDeps = {}
): Promise<ImportZoomTranscriptResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const db = deps.client ?? (await createSupabaseServiceClient());
  const countDocuments = deps.countDocuments ?? countBusinessDocuments;
  const insertDocument = deps.insertDocument ?? insertBusinessDocument;
  const patchDocument = deps.patchDocument ?? patchBusinessDocument;
  const deleteDocument = deps.deleteDocument ?? deleteBusinessDocument;
  const ingest = deps.ingest ?? ingestDocument;
  const syncVault = deps.syncVault ?? syncVaultToVpsAndLog;
  const uuid = deps.uuid ?? randomUUID;
  /* c8 ignore stop */

  const { businessId, business, vtt, title, refLabel } = params;

  const limit = documentLimitForTier(business.tier);
  const existing = await countDocuments(businessId, "library");
  if (existing >= limit) {
    return {
      ok: false,
      error: "limit_reached",
      detail: `Document limit reached for your plan (${limit}). Delete a document or upgrade to add more.`
    };
  }

  const bytes = Buffer.from(vtt, "utf8");
  if (bytes.byteLength > MAX_ZOOM_TRANSCRIPT_BYTES) {
    return {
      ok: false,
      error: "too_large",
      detail: "This transcript is larger than the 10 MB document limit."
    };
  }

  const documentId = uuid();
  const storagePath = `${businessId}/${documentId}/zoom-meeting-${refLabel}.vtt`;

  const { error: uploadError } = await db.storage
    .from(BUSINESS_DOCS_BUCKET)
    .upload(storagePath, bytes, { contentType: `${VTT_MIME_TYPE}; charset=utf-8` });
  if (uploadError) {
    logger.warn("zoom import: storage upload failed", {
      businessId,
      error: uploadError.message
    });
    return { ok: false, error: "storage_failed", detail: "Could not store the transcript" };
  }

  const removeUploadedObject = async (): Promise<void> => {
    const { error: removeError } = await db.storage
      .from(BUSINESS_DOCS_BUCKET)
      .remove([storagePath]);
    if (removeError) {
      logger.warn("zoom import: orphan object cleanup failed", {
        businessId,
        storagePath,
        error: removeError.message
      });
    }
  };

  let row: BusinessDocumentRow;
  try {
    row = await insertDocument({
      id: documentId,
      business_id: businessId,
      title,
      category: "meeting",
      audience: "staff",
      storage_path: storagePath,
      mime_type: VTT_MIME_TYPE,
      byte_size: bytes.byteLength
    });
  } catch (err) {
    await removeUploadedObject();
    throw err;
  }

  // Serial re-check closes the pre-insert cap race (same convention as the
  // documents upload route).
  const afterInsert = await countDocuments(businessId, "library");
  if (afterInsert > limit) {
    await deleteDocument(businessId, documentId);
    await removeUploadedObject();
    return {
      ok: false,
      error: "limit_reached",
      detail: `Document limit reached for your plan (${limit}). Delete a document or upgrade to add more.`
    };
  }

  try {
    const ingested = await ingest({
      businessId,
      title,
      mimeType: VTT_MIME_TYPE,
      data: bytes,
      businessName: business.name
    });
    if (ingested.ok) {
      await patchDocument(businessId, documentId, {
        content_md: ingested.contentMd,
        summary: ingested.summary,
        status: "ready",
        error_detail: null
      });
      // Fire-and-forget: the Supabase write is canonical; a slow VPS must
      // not block the import.
      void syncVault(businessId);
      return {
        ok: true,
        document: row,
        status: "ready",
        errorDetail: null,
        summary: ingested.summary
      };
    }

    const errorDetail = ingested.detail ?? ingested.error;
    await patchDocument(businessId, documentId, {
      status: "failed",
      error_detail: errorDetail
    });
    return { ok: true, document: row, status: "failed", errorDetail, summary: null };
  } catch (err) {
    // An unexpected throw after the row exists must not strand a document:
    // a caller-driven retry (the webhook's 5xx path) would otherwise import
    // a SECOND copy of the same meeting. Roll back and rethrow.
    await deleteDocument(businessId, documentId);
    await removeUploadedObject();
    throw err;
  }
}
