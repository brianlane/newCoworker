import { requireAuth } from "@/lib/auth";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";

export async function GET() {
  try {
    const user = await requireAuth();
    if (!user.email) {
      return errorResponse("VALIDATION_ERROR", "Account has no email address");
    }
    const db = await createSupabaseServiceClient();
    const activeBusinessId = await resolveActiveBusinessIdForAction(user, "view_dashboard", db);
    const { data } = await db
      .from("businesses")
      .select("id, status, name")
      .in("id", activeBusinessId ? [activeBusinessId] : [])
      .limit(1)
      .single();

    return successResponse(data ?? { status: "offline" });
  } catch (err) {
    return handleRouteError(err);
  }
}
