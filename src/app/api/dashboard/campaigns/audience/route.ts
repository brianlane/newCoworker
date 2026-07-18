/**
 * Campaign audience preview — GET /api/dashboard/campaigns/audience
 *   ?businessId=…&tag=…   → { recipients, needsReview, clipped, tags }
 *
 * The composer calls this (debounced) as the owner types an audience tag,
 * so scheduling is never a blind send: it shows how many contacts the
 * campaign would reach and flags Instagram prospects still pending review.
 * Same auth bar as the campaigns list (manage_settings).
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { previewCampaignAudience } from "@/lib/campaigns/audience";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  businessId: z.string().uuid(),
  tag: z.string().trim().max(40).optional()
});

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const url = new URL(request.url);
    const query = querySchema.safeParse({
      businessId: url.searchParams.get("businessId"),
      tag: url.searchParams.get("tag") ?? undefined
    });
    if (!query.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    if (!user.isAdmin) await requireBusinessRole(query.data.businessId, "manage_settings");

    const preview = await previewCampaignAudience(query.data.businessId, query.data.tag ?? "");
    return successResponse(preview);
  } catch (err) {
    return handleRouteError(err);
  }
}
