/**
 * AiFlow run history (read-only list). Owner-only.
 * Query: ?businessId=...&flowId=...&status=...&limit=...
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { listAiFlowRuns, type AiFlowRunStatus } from "@/lib/ai-flows/db";
import { resolveContactNames } from "@/lib/db/contact-names";

const idSchema = z.string().uuid();
const RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_agent",
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
    if (!user.isAdmin) await requireBusinessRole(parsed.data, "manage_aiflows");

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
    // Resolve the offered employees' numbers to roster/contact names so the
    // routing card can stay labelled after an in-page reload (not just the
    // initial server render). Best-effort: on failure the UI falls back to the
    // raw number.
    const employeeNames = await resolveContactNames(
      parsed.data,
      rows.map((r) => r.awaiting_agent_e164).filter((p): p is string => Boolean(p))
    )
      .then((map) => Object.fromEntries([...map.entries()].map(([e164, c]) => [e164, c.name])))
      .catch(() => ({} as Record<string, string>));
    return successResponse({ runs: rows, employeeNames });
  } catch (err) {
    return handleRouteError(err);
  }
}
