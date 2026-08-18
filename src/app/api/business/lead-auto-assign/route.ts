/**
 * Lead auto-assignment preference (Employees page).
 *
 * POST { businessId, leadAutoAssign }, toggle whether route_to_team
 * hard-assigns each lead to the next roster member in rotation instead of
 * running the offer-and-claim handshake. Default is off (offer-and-claim);
 * see migration 20260713222759_lead_auto_assign.
 *
 * Auth: manage_settings on the business (owner/manager), admins bypass.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { setLeadAutoAssign } from "@/lib/db/businesses";
import { recordSystemLog } from "@/lib/db/system-logs";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  leadAutoAssign: z.boolean()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_settings");

    await setLeadAutoAssign(body.businessId, body.leadAutoAssign);
    // Audit-worthy: flipping this changes who is accountable for every new
    // lead (assigned instantly vs claimed by acknowledgment).
    void recordSystemLog({
      businessId: body.businessId,
      source: "app",
      level: "info",
      event: "lead_auto_assign_toggled",
      message: `Lead auto-assignment turned ${body.leadAutoAssign ? "ON" : "OFF"}`,
      payload: { lead_auto_assign: body.leadAutoAssign, by: user.email }
    });
    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
