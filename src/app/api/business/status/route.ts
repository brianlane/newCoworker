import { requireAuth } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";

export async function GET() {
  try {
    const user = await requireAuth();
    if (!user.email) {
      return errorResponse("VALIDATION_ERROR", "Account has no email address");
    }
    const db = await createSupabaseServiceClient();
    const { data } = await db
      .from("businesses")
      .select("id, status, name")
      .eq("owner_email", user.email)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    return successResponse(data ?? { status: "offline" });
  } catch (err) {
    return handleRouteError(err);
  }
}
