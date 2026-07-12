import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { setBusinessPaused } from "@/lib/db/businesses";
import { getBusinessRoleForEmail } from "@/lib/db/business-members";
import { logAdminAction } from "@/lib/admin/audit";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  paused: z.boolean()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const body = bodySchema.parse(await request.json());

    if (!user.isAdmin) {
      await requireBusinessRole(body.businessId, "manage_settings");
    }

    await setBusinessPaused(body.businessId, body.paused);
    if (user.isAdmin) {
      // Only OPERATOR-initiated flips go to the admin audit trail. The one
      // self-service case is the admin pausing a tenant they OWN — anything
      // else (no relationship, or a mere staff/manager grant on a customer
      // business) is a fleet-operator action and must be audited. A failed
      // role lookup fails toward auditing (an extra row beats a gap).
      const selfRole = user.email
        ? await getBusinessRoleForEmail(body.businessId, user.email).catch(() => null)
        : null;
      if (selfRole !== "owner") {
        await logAdminAction({
          adminEmail: user.email,
          action: body.paused ? "kill_switch_pause" : "kill_switch_resume",
          businessId: body.businessId
        });
      }
    }
    return successResponse({ paused: body.paused });
  } catch (err) {
    return handleRouteError(err);
  }
}
