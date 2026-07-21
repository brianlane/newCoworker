/**
 * Team-first human handoff preference (Employees page).
 *
 * POST { businessId, teamFirst } — toggle whether a needs-human escalation
 * broadcasts a claim offer to the whole active roster first (10-minute
 * shared deadline, owner fallback) instead of paging the owner immediately.
 * Toggling ON also creates/re-enables the seeded "Human handoff — offer to
 * team first" flow; toggling OFF disables it. Default is off; see migration
 * 20260817120000_needs_human_team_first.
 *
 * Auth: manage_settings on the business (owner/manager), admins bypass.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { applyNeedsHumanTeamFirstSetting } from "@/lib/ai-flows/needs-human-flow";
import { recordSystemLog } from "@/lib/db/system-logs";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  teamFirst: z.boolean()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    // View-as is read-only: an impersonating admin must not flip tenant
    // routing settings (same rule as the other Settings mutations).
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_settings");

    // Flow armed before the column flips, with a disarm rollback on a failed
    // column write — see applyNeedsHumanTeamFirstSetting for the ordering
    // rationale (a half-applied save must never double-notify or no-op).
    await applyNeedsHumanTeamFirstSetting(body.businessId, body.teamFirst);
    // Audit-worthy: flipping this changes who hears about a customer asking
    // for a human (team broadcast vs the owner directly).
    void recordSystemLog({
      businessId: body.businessId,
      source: "app",
      level: "info",
      event: "needs_human_team_first_toggled",
      message: `Team-first human handoff turned ${body.teamFirst ? "ON" : "OFF"}`,
      payload: { needs_human_team_first: body.teamFirst, by: user.email }
    });
    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
