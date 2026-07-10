/**
 * AiFlow safety preferences (Settings page).
 *
 * POST { businessId, protectStaffContacts } — toggle whether update_contact
 * flow steps may write lead-state tags on owner/employee contacts. Default is
 * protected (true); see migration 20260813000000_aiflow_staff_tag_protection.
 *
 * Auth: manage_settings on the business (owner/manager), admins bypass.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { setAiflowStaffProtection } from "@/lib/db/businesses";
import { recordSystemLog } from "@/lib/db/system-logs";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  protectStaffContacts: z.boolean()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    // View-as is read-only: an impersonating admin must not flip tenant
    // safety settings (same rule as the other Settings mutations).
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_settings");

    await setAiflowStaffProtection(body.businessId, body.protectStaffContacts);
    // Settings flips are audit-worthy: switching protection OFF means flows
    // may start tagging staff rows, which is surprising when forgotten.
    void recordSystemLog({
      businessId: body.businessId,
      source: "app",
      level: "info",
      event: "aiflow_staff_protection_toggled",
      message: `AiFlow staff-contact tag protection turned ${body.protectStaffContacts ? "ON" : "OFF"}`,
      payload: { protect_staff_contacts: body.protectStaffContacts, by: user.email }
    });
    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
