/**
 * Business Documents, correcting who a recorded meeting was with.
 *
 *   POST /api/dashboard/documents/:documentId/reassign
 *        body: { businessId, contactId, wrongName? }
 *
 * Zoom names every transcript line after the ACCOUNT, so a guest joining
 * from an account that is not theirs is recorded, titled, summarized and
 * remembered under somebody else's name, and the meeting attaches to nobody.
 * This is the owner answering the one question the platform could not: who
 * was actually on the call. See src/lib/meetings/reassign.ts for what that
 * answer repairs.
 *
 * Runs INLINE rather than deferred: it re-runs the classification (two
 * metered Gemini calls) and the owner is watching, so the response reports
 * what actually changed instead of "started".
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { reassignMeetingContact } from "@/lib/meetings/reassign";

export const dynamic = "force-dynamic";
// Two Gemini calls plus a vault sync, the same budget the manual Zoom
// import route takes for the same reason.
export const maxDuration = 120;

const bodySchema = z.object({
  businessId: z.string().uuid(),
  contactId: z.string().uuid(),
  /** Override for a name the derivation would not find on its own. */
  wrongName: z.string().trim().max(120).optional()
});

type RouteContext = { params: Promise<{ documentId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { documentId } = await context.params;
    if (!z.string().uuid().safeParse(documentId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid document id");
    }
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        body.error.issues[0]?.message ?? "businessId and contactId are required"
      );
    }
    // Same permission as every other write on this document: rewriting the
    // minutes and moving a pipeline card is settings-grade, not view-grade.
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_settings");

    const result = await reassignMeetingContact({
      businessId: body.data.businessId,
      documentId,
      contactId: body.data.contactId,
      wrongName: body.data.wrongName ?? null
    });
    if (!result.ok) {
      // NOT_FOUND already maps to 404; the rest are owner-actionable copy.
      return result.error === "document_not_found"
        ? errorResponse("NOT_FOUND", result.detail)
        : errorResponse("VALIDATION_ERROR", result.detail);
    }
    return successResponse({ reassign: result });
  } catch (err) {
    return handleRouteError(err);
  }
}
