/**
 * Prospecting — acting on one drafted prospect from the review queue.
 *
 *   POST /api/dashboard/outreach/prospects/<id>  { businessId, action }
 *
 * `send` runs the same send path the sweep uses (same claim, same mailbox, same
 * email_log row, same flow hand-off), so a manual send and an automatic one are
 * one event with one audit trail. `skip` retires the draft, which also keeps its
 * domain out of future discovery: a skip means "not this business", not "ask me
 * again next week".
 *
 * The daily cap applies to a manual send too. The send window does not: the
 * owner is choosing this moment.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { skipProspect } from "@/lib/outreach/owner";
import { sendProspectNow } from "@/lib/outreach/sweep";
import {
  PROSPECTING_UPGRADE_MESSAGE,
  prospectingAllowedForBusiness
} from "@/lib/plans/prospecting";

export const dynamic = "force-dynamic";

const RATE = { interval: 60 * 1000, maxRequests: 30 };

const bodySchema = z.object({
  businessId: z.string().uuid(),
  action: z.enum(["send", "skip"])
});

/** Owner-readable reason a manual send did not happen. */
const SEND_FAILURE_MESSAGE: Record<string, string> = {
  not_found: "That prospect is no longer in your list.",
  not_drafted: "That draft has already been sent, skipped, or is missing its text.",
  cap_reached: "You have reached today's send limit. Try again tomorrow, or raise the cap.",
  not_configured: "Finish setting up Prospecting first.",
  tier_blocked: PROSPECTING_UPGRADE_MESSAGE,
  send_failed: "The email could not be sent. Check your connected mailbox and try again."
};

export async function POST(
  request: Request,
  context: { params: Promise<{ prospectId: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
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
