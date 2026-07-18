/**
 * Import a Zoom meeting transcript into the business's document library.
 *
 *   POST { businessId, meetingId, title? }
 *
 * Fetches the cloud-recording transcript (VTT) through the business's direct
 * Zoom connection (`cloud_recording:read:meeting_transcript` scope), then
 * runs the exact same pipeline as a manual VTT upload to Documents: store
 * the original in the private bucket, insert a document row, condense to
 * meeting minutes via ingestDocument, re-sync the VPS vault. The saved
 * document is staff-only by default — meeting content never reaches
 * customer channels unless the owner deliberately widens it.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusiness } from "@/lib/db/businesses";
import {
  countBusinessDocuments,
  deleteBusinessDocument,
  insertBusinessDocument,
  patchBusinessDocument
} from "@/lib/documents/db";
import { BUSINESS_DOCS_BUCKET, documentLimitForTier } from "@/lib/documents/core";
import { ingestDocument } from "@/lib/documents/ingest";
import { VTT_MIME_TYPE } from "@/lib/transcripts/vtt";
import { fetchZoomMeetingTranscript } from "@/lib/zoom/transcript";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
// Zoom fetch + Gemini condense both run inline (owner-attended action).
export const maxDuration = 120;

// Same ceiling as POST /api/dashboard/documents — an imported transcript
// must not exceed what a manual upload of the same VTT would be allowed.
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const bodySchema = z.object({
  businessId: z.string().uuid(),
  // Zoom meeting ids are numeric (typically 9–11 digits, with longer ids in
  // the wild — e.g. 13 digits); owners paste them with or without spaces
  // ("178 4344 402882").
  meetingId: z
    .string()
    .transform((v) => v.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^\d{9,15}$/, "meetingId must be a Zoom meeting ID")),
  title: z.string().trim().max(200).optional()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "businessId and meetingId are required"
      );
    }
    const { businessId, meetingId } = parsed.data;
    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

    const business = await getBusiness(businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);

    const limit = documentLimitForTier(business.tier);
    const existing = await countBusinessDocuments(businessId, "library");
    if (existing >= limit) {
      return errorResponse(
        "VALIDATION_ERROR",
        `Document limit reached for your plan (${limit}). Delete a document or upgrade to add more.`
      );
    }

    const transcript = await fetchZoomMeetingTranscript(businessId, meetingId);
    if (!transcript.ok) {
      // Every lib failure is owner-actionable copy; surface it verbatim.
      return errorResponse("VALIDATION_ERROR", transcript.detail);
    }

    const title = parsed.data.title || `Zoom meeting ${meetingId} — transcript`;
    const documentId = randomUUID();
    const storagePath = `${businessId}/${documentId}/zoom-meeting-${meetingId}.vtt`;
    const bytes = Buffer.from(transcript.vtt, "utf8");
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      return errorResponse(
        "VALIDATION_ERROR",
        "This transcript is larger than the 10 MB document limit."
      );
    }

    const db = await createSupabaseServiceClient();
    const { error: uploadError } = await db.storage
      .from(BUSINESS_DOCS_BUCKET)
      .upload(storagePath, bytes, { contentType: VTT_MIME_TYPE });
    if (uploadError) {
      logger.warn("zoom import-transcript: storage upload failed", {
        businessId,
        error: uploadError.message
      });
      return errorResponse("INTERNAL_SERVER_ERROR", "Could not store the transcript");
    }

    const removeUploadedObject = async (): Promise<void> => {
      const { error: removeError } = await db.storage
        .from(BUSINESS_DOCS_BUCKET)
        .remove([storagePath]);
      if (removeError) {
        logger.warn("zoom import-transcript: orphan object cleanup failed", {
          businessId,
          storagePath,
          error: removeError.message
        });
      }
    };

    let row;
    try {
      row = await insertBusinessDocument({
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

    // Serial re-check closes the pre-insert cap race (same convention as
    // the documents upload route).
    const afterInsert = await countBusinessDocuments(businessId, "library");
    if (afterInsert > limit) {
      await deleteBusinessDocument(businessId, documentId);
      await removeUploadedObject();
      return errorResponse(
        "VALIDATION_ERROR",
        `Document limit reached for your plan (${limit}). Delete a document or upgrade to add more.`
      );
    }

    const ingested = await ingestDocument({
      businessId,
      title,
      mimeType: VTT_MIME_TYPE,
      data: bytes,
      businessName: business.name
    });
    if (ingested.ok) {
      await patchBusinessDocument(businessId, documentId, {
        content_md: ingested.contentMd,
        summary: ingested.summary,
        status: "ready",
        error_detail: null
      });
      // Fire-and-forget: the Supabase write is canonical; a slow VPS must
      // not block the import response.
      void syncVaultToVpsAndLog(businessId);
    } else {
      await patchBusinessDocument(businessId, documentId, {
        status: "failed",
        error_detail: ingested.detail ?? ingested.error
      });
    }

    return successResponse({
      document: {
        ...row,
        status: ingested.ok ? "ready" : "failed",
        error_detail: ingested.ok ? null : ingested.detail ?? ingested.error
      },
      summary: ingested.ok ? ingested.summary : null
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
