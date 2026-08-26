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
import {
  buildZoomGuestHeadingTitle,
  extractFirstMinutesHeading,
  extractVttSpeakers,
  isGenericZoomTopic,
  pickZoomGuestName,
  zoomTopicFromTitle
} from "@/lib/zoom/document-title";
import { VTT_MIME_TYPE, vttToPlainText } from "@/lib/transcripts/vtt";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";
import { scheduleMeetingClassification } from "@/lib/meetings/apply-outcome";
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
  /**
   * Names that count as "us" when picking the guest out of the speaker list:
   * the Zoom connection's account_name plus the business name. Anyone else who
   * spoke is the guest the title is named after. Omitted means every speaker
   * is a candidate.
   */
  hostNames?: string[];
  /**
   * Zoom's past-meeting instance UUID. The classification's dedupe key and
   * its ledger row. Omitted disables the classification pass: without it
   * there is nothing to stamp, so a retry could not be told from a first
   * run and would duplicate the note and the to-dos.
   */
  meetingUuid?: string;
  /**
   * Zoom's numeric meeting id, the join key into the booking ledger and so
   * the deterministic half of contact attribution. Omitted still classifies;
   * attribution falls back to the transcript.
   */
  zoomMeetingId?: string | null;
};

export type ImportZoomTranscriptDeps = {
  client?: SupabaseClient;
  countDocuments?: typeof countBusinessDocuments;
  insertDocument?: typeof insertBusinessDocument;
  patchDocument?: typeof patchBusinessDocument;
  deleteDocument?: typeof deleteBusinessDocument;
  ingest?: typeof ingestDocument;
  syncVault?: typeof syncVaultToVpsAndLog;
  scheduleClassification?: typeof scheduleMeetingClassification;
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
  const scheduleClassification =
    deps.scheduleClassification ?? scheduleMeetingClassification;
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
    .upload(storagePath, bytes, { contentType: VTT_MIME_TYPE });
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
      // Only now do we know who was on the call and what the minutes call it,
      // so this is the first point a better title than Zoom's topic exists.
      // Rides the same patch: a second write would be a second chance to fail
      // and leave the row half-updated.
      const derivedTitle = deriveZoomDocumentTitle({
        provisionalTitle: title,
        vtt,
        contentMd: ingested.contentMd,
        summary: ingested.summary,
        hostNames: params.hostNames ?? []
      });
      await patchDocument(businessId, documentId, {
        content_md: ingested.contentMd,
        summary: ingested.summary,
        status: "ready",
        error_detail: null,
        ...(derivedTitle ? { title: derivedTitle } : {})
      });
      // Fire-and-forget: the Supabase write is canonical; a slow VPS must
      // not block the import.
      void syncVault(businessId);
      // Now that the minutes exist, decide what the meeting WAS and apply it
      // to the person it was with (link, note, stage move, to-dos). Deferred
      // past the response and individually guarded: the document is the
      // valuable part and it is already saved. Needs the meeting UUID for
      // its exactly-once stamp, so an import that could not resolve one
      // (a legacy reference shape) files the document and stops there.
      if (params.meetingUuid) {
        scheduleClassification({
          businessId,
          documentId,
          documentTitle: derivedTitle ?? title,
          content: ingested.contentMd,
          summary: ingested.summary,
          vtt,
          meetingUuid: params.meetingUuid,
          zoomMeetingId: params.zoomMeetingId ?? null,
          hostNames: params.hostNames ?? []
        });
      }
      return {
        ok: true,
        // `row` came from the insert, so it still carries the provisional
        // title. Returning it as-is made the manual import's API response
        // show the old generic Zoom title while the DB already held the
        // derived one, and the dashboard renders straight from this.
        document: derivedTitle ? { ...row, title: derivedTitle } : row,
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

/**
 * A better title than Zoom's topic, or null to keep the provisional one.
 *
 * Only overrides a GENERIC topic. A host who bothered to name their meeting
 * has said something we cannot improve on, and silently renaming it would be
 * worse than the collision this fixes.
 */
function deriveZoomDocumentTitle(input: {
  provisionalTitle: string;
  vtt: string;
  contentMd: string;
  summary: string | null;
  hostNames: string[];
}): string | null {
  // The provisional title is "<topic> · <date> (transcript)" and friends, so
  // strip the decoration back to the topic before judging it.
  if (!isGenericZoomTopic(zoomTopicFromTitle(input.provisionalTitle))) return null;

  const guest = pickZoomGuestName({
    speakers: extractVttSpeakers(vttToPlainText(input.vtt)),
    hostNames: input.hostNames,
    summary: input.summary
  });
  const heading = extractFirstMinutesHeading(input.contentMd);
  const derived = buildZoomGuestHeadingTitle({ guest, heading });
  if (!derived || derived === input.provisionalTitle) return null;
  return derived;
}

/**
 * Names that count as "us" for guest detection: the business name plus the
 * connected Zoom account's display name (the host speaks under the latter).
 *
 * Never throws. This only affects how nice the document title is, so a
 * connection lookup blip must not fail the import.
 */
export async function resolveHostNames(
  businessName: string,
  loadConnection: () => Promise<{ account_name: string | null } | null>
): Promise<string[]> {
  let accountName: string | null = null;
  try {
    accountName = (await loadConnection())?.account_name ?? null;
  } catch (err) {
    logger.warn("zoom: host-name lookup failed; falling back to the business name", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return [businessName, accountName ?? ""].filter((n) => n.trim() !== "");
}
