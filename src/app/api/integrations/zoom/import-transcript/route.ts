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
 * The manual path participates in the same dedupe ledger as the webhook
 * auto-import (when the pasted reference carries the meeting UUID): it
 * claims the meeting first, politely refuses when an auto-import is
 * actively mid-flight for it (instead of producing a duplicate document),
 * and treats a PREVIOUSLY COMPLETED import as a deliberate re-import (the
 * owner may have deleted the document). A held claim is released on
 * failure; success stamps the produced document onto the ledger row.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import { recordSystemLog } from "@/lib/db/system-logs";
import {
  claimZoomTranscriptImport,
  finalizeZoomTranscriptImport,
  getZoomTranscriptImport,
  reclaimCompletedZoomTranscriptImport,
  releaseZoomTranscriptImport
} from "@/lib/db/zoom-transcript-imports";
import { importZoomTranscriptDocument } from "@/lib/zoom/import-core";
import {
  fetchZoomMeetingTranscript,
  rawZoomMeetingUuid,
  resolvePastMeetingUuid
} from "@/lib/zoom/transcript";

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

    // Coordinate with the webhook auto-import through the shared ledger.
    // A pasted link/UUID carries the key directly; a NUMERIC id resolves to
    // its past-meeting instance UUID (fail-open pre-scope: null keeps the
    // legacy unkeyed flow), closing the numeric-ID dedupe bypass.
    const digitsRef = meetingId.replace(/\s+/g, "");
    const meetingUuid =
      rawZoomMeetingUuid(meetingId) ??
      (/^\d{9,15}$/.test(digitsRef)
        ? await resolvePastMeetingUuid(businessId, digitsRef)
        : null);
    let holdsClaim = false;
    if (meetingUuid) {
      holdsClaim = await claimZoomTranscriptImport(businessId, meetingUuid);
      if (!holdsClaim) {
        const existing = await getZoomTranscriptImport(businessId, meetingUuid);
        if (existing && existing.document_id !== null) {
          // Completed before: a deliberate RE-import (the owner may have
          // deleted the document). Atomically flip the row back to
          // in-flight so concurrent re-imports serialize; the loser falls
          // through to the in-flight refusal below.
          holdsClaim = await reclaimCompletedZoomTranscriptImport(businessId, meetingUuid);
        } else if (!existing) {
          // The claim vanished between attempts (a failing webhook import
          // released it): the slot is free, take it now instead of showing
          // a false already-importing refusal.
          holdsClaim = await claimZoomTranscriptImport(businessId, meetingUuid);
        }
        if (!holdsClaim) {
          // An import holds a fresh claim right now; a second copy would
          // just be a duplicate document.
          return errorResponse(
            "VALIDATION_ERROR",
            "Your coworker is already importing this meeting's minutes automatically. Check Documents in a minute or two."
          );
        }
      }
    }
    const releaseHeldClaim = async (): Promise<void> => {
      if (holdsClaim && meetingUuid) {
        await releaseZoomTranscriptImport(businessId, meetingUuid);
      }
    };

    try {
      const transcript = await fetchZoomMeetingTranscript(businessId, meetingId);
      if (!transcript.ok) {
        await releaseHeldClaim();
        // Every lib failure is owner-actionable copy; surface it verbatim.
        return errorResponse("VALIDATION_ERROR", transcript.detail);
      }

      // The pasted reference may be a UUID or a full recording link, neither
      // is filename/title material. Label with the digits when it's a plain
      // meeting ID, else a generic marker.
      const refLabel = /^\d{9,15}$/.test(digitsRef) ? digitsRef : "recording";
      const title = parsed.data.title || `Zoom meeting ${refLabel} (transcript)`;

      const imported = await importZoomTranscriptDocument({
        businessId,
        business: { name: business.name, tier: business.tier },
        vtt: transcript.vtt,
        title,
        refLabel
      });

      if (!imported.ok) {
        await releaseHeldClaim();
        if (imported.error === "storage_failed") {
          return errorResponse("INTERNAL_SERVER_ERROR", imported.detail);
        }
        return errorResponse("VALIDATION_ERROR", imported.detail);
      }

      // Stamp the produced document onto the ledger row (also repoints it on
      // a deliberate re-import) so webhook deliveries stay no-ops. Retry the
      // stamp once and escalate like the webhook path does: an unstamped row
      // is a lease-steal duplicate hazard ops should repair.
      if (meetingUuid) {
        const finalized =
          (await finalizeZoomTranscriptImport(businessId, meetingUuid, imported.document.id)) ||
          (await finalizeZoomTranscriptImport(businessId, meetingUuid, imported.document.id));
        if (!finalized) {
          await recordSystemLog({
            businessId,
            source: "zoom-import",
            event: "zoom_ledger_finalize_failed",
            level: "error",
            message:
              "Manual Zoom import succeeded but the ledger stamp failed twice; repair zoom_transcript_imports.document_id to prevent a lease-steal duplicate",
            payload: { meetingUuid, documentId: imported.document.id }
          });
        }
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
      // A throw anywhere past the claim must not leave the in-flight row
      // blocking webhook dedupe until the lease expires.
      await releaseHeldClaim();
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
