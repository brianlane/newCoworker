/**
 * Prospecting: write every waiting draft again, one batch per request.
 *
 *   POST /api/dashboard/outreach/rewrite-all  { businessId, since? }
 *
 * The bulk twin of the per-prospect `regenerate` action. It exists for the case
 * the single-draft button cannot cover: the owner changed what the email offers
 * (or who signs it, or the footer address) and the drafts already queued still
 * carry the old wording. Pressing Write it again a hundred and sixty times is
 * not a workflow.
 *
 * Batched on purpose. Each rewrite spends a Gemini tone pass, so the work is
 * cut into `REWRITE_BATCH_SIZE` slices and the client loops, echoing back the
 * `startedAt` cursor it was handed. One long request would sit behind the edge
 * timeout and throw away everything it had already done.
 *
 * No prospect's site is fetched again: every rewrite re-composes from the
 * findings already stored on the row.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { rewriteAllProspectDrafts } from "@/lib/outreach/sweep";
import { PROSPECTING_UPGRADE_MESSAGE } from "@/lib/plans/prospecting";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** One press can be a dozen calls, so the ceiling sits above a full sweep of a busy queue. */
const RATE = { interval: 60 * 1000, maxRequests: 60 };

const bodySchema = z.object({
  businessId: z.string().uuid(),
  /** The cursor from the previous batch. Absent on the first call of a run. */
  since: z.string().datetime({ offset: true }).optional()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_settings");

    const limiter = rateLimit(`outreach-rewrite-all:${body.data.businessId}`, RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    // Starter is refused inside rewriteAllProspectDrafts, by the same
    // resolveTenant gate the sweep uses, so there is no second plan check here.
    const result = await rewriteAllProspectDrafts(body.data.businessId, {
      since: body.data.since
    });
    if (!result.ok) {
      if (result.reason === "tier_blocked") {
        return errorResponse("FORBIDDEN", PROSPECTING_UPGRADE_MESSAGE, 403);
      }
      return errorResponse("VALIDATION_ERROR", "Finish setting up Prospecting first.");
    }
    return successResponse({
      startedAt: result.startedAt,
      rewritten: result.rewritten,
      skipped: result.skipped,
      remaining: result.remaining
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
