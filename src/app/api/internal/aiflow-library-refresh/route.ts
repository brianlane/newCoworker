/**
 * Internal endpoint that rebuilds the public AiFlow library.
 *
 * Kicked hourly by the aiflow-library-refresh Edge cron bridge: it aggregates
 * every flow with a successful run across all tenants, scrubs PII, and upserts
 * one library entry per template. Runs in the Node runtime so the scrub/refresh
 * logic stays in src/lib (under the coverage gate).
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` — same shape and secret
 * as the other /api/internal/* endpoints.
 */
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { refreshAiFlowLibrary } from "@/lib/ai-flows/library-refresh";

// Aggregation + per-group scrub/upsert across all tenants; 120s of headroom.
export const maxDuration = 120;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const result = await refreshAiFlowLibrary();
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
