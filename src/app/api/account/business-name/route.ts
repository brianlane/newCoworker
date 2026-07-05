/**
 * Owner-facing: rename the signed-in account's business.
 *
 * Auth: owner-only (Supabase session). The business is resolved by the auth
 * user's email (the same `owner_email` linkage every other owner route uses),
 * so a caller can only ever rename their own business.
 */
import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { updateBusinessName } from "@/lib/db/businesses";

const schema = z.object({
  name: z.string().trim().min(1, "Business name is required").max(120, "Business name is too long")
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    // View-as is read-only: this route resolves the business from the
    // SIGNED-IN user's email, so an impersonating admin's write would land
    // on the wrong business. Refuse instead (see isViewAsActive).
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only — exit view-as to make changes", 403);
    }
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { name } = schema.parse(await request.json());

    const db = await createSupabaseServiceClient();
    // Target the newest business, matching how the dashboard layout, billing
    // routes, and the Settings page resolve "the" business for an owner who has
    // more than one row under the same owner_email — so the rename hits the row
    // the user is actually looking at.
    const { data: biz } = await db
      .from("businesses")
      .select("id")
      .eq("owner_email", user.email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!biz) return errorResponse("NOT_FOUND", "No business found for this account");

    await updateBusinessName((biz as { id: string }).id, name, db);
    return successResponse({ name });
  } catch (err) {
    return handleRouteError(err);
  }
}
