/**
 * Owner-facing: set the signed-in account's business timezone (IANA name).
 *
 * Auth + business resolution mirror /api/account/business-name: the newest
 * business under the auth user's owner_email, so a caller can only ever
 * touch their own business. Validation is "can Intl.DateTimeFormat format
 * with it" — the exact consumer of the value downstream.
 */
import { z } from "zod";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { isValidIanaTimezone, updateBusinessTimezone } from "@/lib/db/businesses";
import { refreshBusinessProfileMdAndLog } from "@/lib/business-profile/refresh";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";

const schema = z.object({
  timezone: z.union([z.string().trim().min(1).max(64), z.null()])
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    // View-as is read-only: this route resolves the business from the
    // SIGNED-IN user's email, so an impersonating admin's write would land
    // on the wrong business. Refuse instead (see isViewAsActive).
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { timezone } = schema.parse(await request.json());
    if (timezone !== null && !isValidIanaTimezone(timezone)) {
      return errorResponse("VALIDATION_ERROR", "Unknown timezone");
    }

    const db = await createSupabaseServiceClient();
    const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_settings");
    const { data: biz } = await db
      .from("businesses")
      .select("id")
      .in("id", activeBusinessId ? [activeBusinessId] : [])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!biz) return errorResponse("NOT_FOUND", "No business found for this account");

    await updateBusinessTimezone((biz as { id: string }).id, timezone, db);
    // The timezone appears in the rendered Business-profile block; keep the
    // canonical profile_md fresh and push it to the live agent. Best-effort
    // after the committed write — never fail the user's successful save.
    await refreshBusinessProfileMdAndLog((biz as { id: string }).id, db);
    void syncVaultToVpsAndLog((biz as { id: string }).id);
    return successResponse({ timezone });
  } catch (err) {
    return handleRouteError(err);
  }
}
