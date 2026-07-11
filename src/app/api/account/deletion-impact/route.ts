/**
 * Owner-facing: preview what account deletion would remove (BizBlasts-style
 * impact counts) plus whether deletion is currently allowed or the owner
 * must cancel their subscription first.
 */
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { SubscriptionRow } from "@/lib/db/subscriptions";
import {
  getAccountDeletionImpact,
  resolveAccountDeletionEligibility
} from "@/lib/account/deletion";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");

    const db = await createSupabaseServiceClient();
    // Owner-only, matching the DELETE route this preview feeds.
    const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_billing");
    const { data: biz } = await db
      .from("businesses")
      .select("id")
      .in("id", activeBusinessId ? [activeBusinessId] : [])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!biz) return errorResponse("NOT_FOUND", "No business found for this account");
    const businessId = (biz as { id: string }).id;

    // Same FAIL-CLOSED billing lookup as the DELETE handler — the preview
    // must never advertise deletion the actual request would refuse.
    const [impact, subLookup] = await Promise.all([
      getAccountDeletionImpact(businessId, db),
      db
        .from("subscriptions")
        .select("status, grace_ends_at, wiped_at")
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    ]);
    if (!impact) return errorResponse("NOT_FOUND", "Business not found", 404);
    if (subLookup.error) {
      logger.error("account.deletion-impact: subscription lookup failed (fail closed)", {
        businessId,
        error: subLookup.error.message
      });
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        "Could not verify billing state; please retry",
        500
      );
    }

    const eligibility = resolveAccountDeletionEligibility(
      (subLookup.data as Pick<SubscriptionRow, "status" | "grace_ends_at" | "wiped_at"> | null) ??
        null
    );
    return successResponse({ impact, eligibility });
  } catch (err) {
    return handleRouteError(err);
  }
}
