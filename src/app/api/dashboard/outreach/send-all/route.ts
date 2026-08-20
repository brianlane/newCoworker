/**
 * Prospecting: send the waiting drafts now, one batch per request.
 *
 *   POST /api/dashboard/outreach/send-all  { businessId }
 *
 * The owner does not want to wait for tomorrow morning's window. The SEND
 * WINDOW is therefore not enforced, exactly as it is not for the single Send
 * button beside each draft: the owner is choosing this moment.
 *
 * The DAILY CAP is enforced, for the reason it exists. A few hundred cold
 * emails leaving one mailbox in a burst is how a sending domain gets rate
 * limited, and a button that quietly suspended the tenant's own
 * deliverability rule would be doing them harm on request. "All" means "as
 * many as today allows"; the panel says how many that is before the press, and
 * the rest stay queued for the next pass.
 *
 * Batched like the bulk rewrite: each send is a provider round-trip plus a
 * flow hand-off, and the client loops until nothing is left to send today.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { sendDraftsNow } from "@/lib/outreach/sweep";
import {
  PROSPECTING_UPGRADE_MESSAGE,
  prospectingAllowedForBusiness
} from "@/lib/plans/prospecting";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** One press is several calls, so the ceiling clears a full day's cap. */
const RATE = { interval: 60 * 1000, maxRequests: 60 };

const bodySchema = z.object({ businessId: z.string().uuid() });

/** Owner-readable reason nothing could be sent. */
const FAILURE_MESSAGE = {
  not_configured: "Finish setting up Prospecting first.",
  tier_blocked: PROSPECTING_UPGRADE_MESSAGE,
  no_mailbox:
    "Connect the mailbox this should be sent from on the Integrations page first. Your drafts are untouched."
} as const;

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_settings");

    const limiter = rateLimit(`outreach-send-all:${body.data.businessId}`, RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }
    // Sending is the one action worth its own plan check before the library's:
    // it spends the tenant's mailbox reputation, not just a model call.
    if (!(await prospectingAllowedForBusiness(body.data.businessId))) {
      return errorResponse("FORBIDDEN", PROSPECTING_UPGRADE_MESSAGE, 403);
    }

    const result = await sendDraftsNow(body.data.businessId);
    if (!result.ok) {
      if (result.reason === "tier_blocked") {
        return errorResponse("FORBIDDEN", FAILURE_MESSAGE.tier_blocked, 403);
      }
      return errorResponse("VALIDATION_ERROR", FAILURE_MESSAGE[result.reason]);
    }
    return successResponse({
      sent: result.sent,
      remaining: result.remaining,
      allowanceLeft: result.allowanceLeft,
      notes: result.notes
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
