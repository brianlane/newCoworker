/**
 * Prospecting: acting on one drafted prospect from the review queue.
 *
 *   POST /api/dashboard/outreach/prospects/<id>  { businessId, action, ... }
 *
 * `send` runs the same send path the sweep uses (same claim, same mailbox, same
 * email_log row, same flow hand-off), so a manual send and an automatic one are
 * one event with one audit trail. `skip` retires the draft, which also keeps its
 * domain out of future discovery: a skip means "not this business", not "ask me
 * again next week". `edit` replaces the writing with the owner's own, and
 * `regenerate` has the coworker write it again from the same findings.
 *
 * Edit takes the PARAGRAPHS, never the whole email: the CTA, signature,
 * unsubscribe link, and postal address are re-assembled in code around
 * whatever the owner submits, so an edit can never delete the compliance
 * footer (src/lib/outreach/sweep.ts, editProspectDraft).
 *
 * The daily cap applies to a manual send too. The send window does not: the
 * owner is choosing this moment.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { skipProspect } from "@/lib/outreach/owner";
import {
  editProspectDraft,
  MAX_EDITED_BODY_CHARS,
  MAX_EDITED_SUBJECT_CHARS,
  regenerateProspectDraft,
  sendProspectNow,
  type DraftUpdateResult
} from "@/lib/outreach/sweep";
import {
  PROSPECTING_UPGRADE_MESSAGE,
  prospectingAllowedForBusiness
} from "@/lib/plans/prospecting";

export const dynamic = "force-dynamic";

const RATE = { interval: 60 * 1000, maxRequests: 30 };

const bodySchema = z.object({
  businessId: z.string().uuid(),
  action: z.enum(["send", "skip", "edit", "regenerate"]),
  /** Edit only. Absent for every other action. */
  subject: z.string().max(MAX_EDITED_SUBJECT_CHARS).optional(),
  /** Edit only: the paragraphs, without the footer. */
  paragraphs: z.string().max(MAX_EDITED_BODY_CHARS).optional()
});

/** Owner-readable reason a manual send did not happen. */
const SEND_FAILURE_MESSAGE: Record<string, string> = {
  not_found: "That prospect is no longer in your list.",
  not_drafted: "That draft has already been sent, skipped, or is missing its text.",
  // Names the control that fixes it. "Raise the cap" is only useful advice if
  // the owner knows the cap is theirs, adjustable, and on this very page.
  cap_reached:
    "You have reached today's send limit. The rest go out on the next pass, or raise Emails per day above and save.",
  not_configured: "Finish setting up Prospecting first.",
  tier_blocked: PROSPECTING_UPGRADE_MESSAGE,
  no_mailbox:
    "Connect the mailbox this should be sent from on the Integrations page first. Your draft is untouched.",
  send_failed: "The email could not be sent. Check your connected mailbox and try again."
};

/** Owner-readable reason an edit or a regenerate did not happen. */
const DRAFT_FAILURE_MESSAGE: Record<Extract<DraftUpdateResult, { ok: false }>["reason"], string> = {
  not_found: "That prospect is no longer in your list.",
  not_drafted: "That draft has already been sent or skipped, so it can no longer be changed.",
  not_configured: "Finish setting up Prospecting first.",
  tier_blocked: PROSPECTING_UPGRADE_MESSAGE,
  empty_text: "A draft needs a subject line and something to say.",
  too_long: "That is longer than a cold email should be. Trim it and try again.",
  not_pitchable: "There is nothing specific enough left to say about this business. Skip it instead."
};

export async function POST(
  request: Request,
  context: { params: Promise<{ prospectId: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { prospectId } = await context.params;
    const id = z.string().uuid().safeParse(prospectId);
    if (!id.success) return errorResponse("VALIDATION_ERROR", "Invalid prospect id");
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_settings");

    const limiter = rateLimit(`outreach-prospect:${body.data.businessId}`, RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    if (body.data.action === "skip") {
      // A review queue can be minutes stale, so a Skip that finds no draft is
      // reported rather than answered with a cheerful success.
      const skipped = await skipProspect(body.data.businessId, id.data);
      if (!skipped) {
        return errorResponse("VALIDATION_ERROR", SEND_FAILURE_MESSAGE.not_drafted);
      }
      return successResponse({ status: "skipped" });
    }

    if (body.data.action === "edit" || body.data.action === "regenerate") {
      // Both refuse a Starter tenant themselves (resolveTenant classifies it
      // as tier_blocked), so there is no separate plan check here: regenerate
      // spends a Gemini call, and the gate that stops it is the same one the
      // sweep uses.
      const result =
        body.data.action === "edit"
          ? await editProspectDraft(body.data.businessId, id.data, {
              subject: body.data.subject ?? "",
              paragraphs: body.data.paragraphs ?? ""
            })
          : await regenerateProspectDraft(body.data.businessId, id.data);
      if (!result.ok) {
        const message = result.detail
          ? `${DRAFT_FAILURE_MESSAGE[result.reason]} (${result.detail})`
          : DRAFT_FAILURE_MESSAGE[result.reason];
        if (result.reason === "tier_blocked") return errorResponse("FORBIDDEN", message, 403);
        return errorResponse("VALIDATION_ERROR", message);
      }
      return successResponse({ status: body.data.action, prospect: result.prospect });
    }

    if (!(await prospectingAllowedForBusiness(body.data.businessId))) {
      return errorResponse("FORBIDDEN", PROSPECTING_UPGRADE_MESSAGE, 403);
    }

    const sent = await sendProspectNow(body.data.businessId, id.data);
    if (!sent.ok) {
      if (sent.reason === "tier_blocked") {
        return errorResponse("FORBIDDEN", SEND_FAILURE_MESSAGE.tier_blocked, 403);
      }
      return errorResponse(
        sent.reason === "cap_reached" ? "CONFLICT" : "VALIDATION_ERROR",
        sent.detail
          ? `${SEND_FAILURE_MESSAGE[sent.reason]} (${sent.detail})`
          : SEND_FAILURE_MESSAGE[sent.reason],
        sent.reason === "cap_reached" ? 409 : 400
      );
    }
    return successResponse({ status: "sent", notes: sent.notes });
  } catch (err) {
    return handleRouteError(err);
  }
}
