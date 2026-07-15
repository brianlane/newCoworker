/**
 * Agents — run history.
 *
 *   GET /api/dashboard/agents/:agentId/runs?businessId=…&limit=…
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { listAgentRuns } from "@/lib/agents/db";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { agentId } = await context.params;
    if (!z.string().uuid().safeParse(agentId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid agent id");
    }
    const url = new URL(request.url);
    const businessId = z.string().uuid().safeParse(url.searchParams.get("businessId"));
    if (!businessId.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") ?? "20") || 20, 1),
      100
    );
    if (!user.isAdmin) await requireBusinessRole(businessId.data, "view_dashboard");

    const runs = await listAgentRuns(businessId.data, agentId, limit);
    return successResponse({ runs });
  } catch (err) {
    return handleRouteError(err);
  }
}
