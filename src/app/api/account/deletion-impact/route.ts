/**
 * Owner-facing: preview what account deletion would remove (BizBlasts-style
 * impact counts) plus whether deletion is currently allowed or the owner
 * must cancel their subscription first.
 */
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription } from "@/lib/db/subscriptions";
import {
  getAccountDeletionImpact,
  resolveAccountDeletionEligibility
} from "@/lib/account/deletion";

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

    const [impact, subscription] = await Promise.all([
      getAccountDeletionImpact(businessId, db),
      getSubscription(businessId, db)
    ]);
    if (!impact) return errorResponse("NOT_FOUND", "Business not found", 404);

    const eligibility = resolveAccountDeletionEligibility(subscription);
    return successResponse({ impact, eligibility });
  } catch (err) {
    return handleRouteError(err);
  }
}
