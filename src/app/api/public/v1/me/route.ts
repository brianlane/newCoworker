/**
 * GET /api/public/v1/me — identify the business behind an API key.
 *
 * Zapier calls this as its auth "test" endpoint (the label shown next to a
 * connected account), and it doubles as a cheap connectivity check for any
 * external client. Auth: `Authorization: Bearer nck_…` (public API key).
 */

import { authenticatePublicApiRequest } from "@/lib/public-api/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await authenticatePublicApiRequest(request);
    if (!auth) return errorResponse("UNAUTHORIZED", "Invalid or missing API key");

    const db = await createSupabaseServiceClient();
    const { data, error } = await db
      .from("businesses")
      .select("id, name, tier, status, timezone")
      .eq("id", auth.businessId)
      .single();
    if (error || !data) {
      return errorResponse("NOT_FOUND", "Business not found for this API key");
    }

    return successResponse({
      business_id: data.id,
      name: data.name,
      tier: data.tier,
      status: data.status,
      timezone: data.timezone ?? null
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
