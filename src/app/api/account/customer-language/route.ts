/**
 * Owner-facing: set the business's default customer-facing language, the
 * language the coworker opens with when a customer's own language is
 * unknown or ambiguous (per-contact detection still overrides per person).
 *
 * Auth + business resolution mirror /api/account/timezone: the signed-in
 * user's active business under `manage_settings`, so a caller can only
 * ever touch their own business. Unlike the timezone route there is no
 * profile_md refresh or vault sync: default_customer_language is not
 * rendered into the business profile, and every consumer (SMS inbound
 * worker, voice IVR, voice-bridge persona) reads the businesses row live.
 */
import { z } from "zod";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { updateBusinessDefaultCustomerLanguage } from "@/lib/db/businesses";

const schema = z.object({
  language: z.enum(["en", "es"])
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { language } = schema.parse(await request.json());

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

    await updateBusinessDefaultCustomerLanguage((biz as { id: string }).id, language, db);
    return successResponse({ language });
  } catch (err) {
    return handleRouteError(err);
  }
}
