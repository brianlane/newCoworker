/**
 * Import a Zoom meeting transcript into the business's document library.
 *
 *   POST { businessId, meetingId, title? }
 *
 * Fetches the cloud-recording transcript (VTT) through the business's direct
 * Zoom connection (`cloud_recording:read:meeting_transcript` scope), then
 * runs the shared import pipeline (src/lib/zoom/import-core.ts, the same
 * core the recording.transcript_completed webhook auto-import uses): store
 * the original in the private bucket, insert a document row, condense to
 * meeting minutes via ingestDocument, re-sync the VPS vault. The saved
 * document is staff-only by default, meeting content never reaches
 * customer channels unless the owner deliberately widens it.
 *
 * A successful manual import records the meeting in the dedupe ledger
 * (best-effort, when the pasted reference carries the meeting UUID) so a
 * later webhook delivery for the same meeting is a no-op. The ledger never
 * BLOCKS a manual import, the owner asked explicitly.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import { recordManualZoomTranscriptImport } from "@/lib/db/zoom-transcript-imports";
import { importZoomTranscriptDocument } from "@/lib/zoom/import-core";
import { fetchZoomMeetingTranscript, rawZoomMeetingUuid } from "@/lib/zoom/transcript";

export const dynamic = "force-dynamic";
// Zoom fetch + Gemini condense both run inline (owner-attended action).
export const maxDuration = 120;

const bodySchema = z.object({
  businessId: z.string().uuid(),
  // Anything normalizeZoomMeetingRef understands: numeric meeting ID,
  // meeting UUID, or the recording page link. Validated by the lib (an
  // unreadable reference comes back as a typed not_found with owner copy).
  meetingId: z.string().trim().min(1).max(500),
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

    const transcript = await fetchZoomMeetingTranscript(businessId, meetingId);
    if (!transcript.ok) {
      // Every lib failure is owner-actionable copy; surface it verbatim.
      return errorResponse("VALIDATION_ERROR", transcript.detail);
    }

    // The pasted reference may be a UUID or a full recording link, neither
    // is filename/title material. Label with the digits when it's a plain
    // meeting ID, else a generic marker.
    const digits = meetingId.replace(/\s+/g, "");
    const refLabel = /^\d{9,15}$/.test(digits) ? digits : "recording";
    const title = parsed.data.title || `Zoom meeting ${refLabel} (transcript)`;

    const imported = await importZoomTranscriptDocument({
      businessId,
      business: { name: business.name, tier: business.tier },
      vtt: transcript.vtt,
      title,
      refLabel
    });

    if (!imported.ok) {
      if (imported.error === "storage_failed") {
        return errorResponse("INTERNAL_SERVER_ERROR", imported.detail);
      }
      return errorResponse("VALIDATION_ERROR", imported.detail);
    }

    // Suppress a later webhook auto-import of the same meeting (best-effort;
    // only possible when the pasted reference carried the meeting UUID).
    const meetingUuid = rawZoomMeetingUuid(meetingId);
    if (meetingUuid) {
      await recordManualZoomTranscriptImport(businessId, meetingUuid, imported.document.id);
    }

    return successResponse({
      document: {
        ...imported.document,
        status: imported.status,
        error_detail: imported.errorDetail
      },
      summary: imported.summary
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
