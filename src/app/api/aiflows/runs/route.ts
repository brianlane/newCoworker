/**
 * AiFlow run history (read-only list). Owner-only.
 * Query: ?businessId=...&flowId=...&status=...&limit=...
 */
import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { listAiFlowRuns, type AiFlowRunStatus } from "@/lib/ai-flows/db";

const idSchema = z.string().uuid();
const RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "done",
  "failed",
  "canceled"
] as const;

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const url = new URL(request.url);
    const businessId = url.searchParams.get("businessId");
    const parsed = idSchema.safeParse(businessId);
    if (!parsed.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    if (!user.isAdmin) await requireOwner(parsed.data);

    const flowId = url.searchParams.get("flowId") ?? undefined;
    const statusRaw = url.searchParams.get("status");
    const status = RUN_STATUSES.includes((statusRaw ?? "") as AiFlowRunStatus)
      ? (statusRaw as AiFlowRunStatus)
      : undefined;
    const limitRaw = Number(url.searchParams.get("limit") ?? "");
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

    const rows = await listAiFlowRuns(parsed.data, {
      flowId: flowId && idSchema.safeParse(flowId).success ? flowId : undefined,
      status,
      limit
    });
    return successResponse(rows);
  } catch (err) {
    return handleRouteError(err);
  }
}
