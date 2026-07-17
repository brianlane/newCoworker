import { z } from "zod";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { setContactLanguageOwnerOverride } from "@/lib/db/contact-language";

const schema = z.object({
  customerE164: z.string().min(3).max(40),
  language: z.enum(["en", "es"]).nullable()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required", 401);
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }

    const body = schema.parse(await request.json());
    const businessId = await resolveActiveBusinessIdForAction(user, "manage_settings");
    if (!businessId) return errorResponse("NOT_FOUND", "No business found");

    await setContactLanguageOwnerOverride(businessId, body.customerE164, body.language);
    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
