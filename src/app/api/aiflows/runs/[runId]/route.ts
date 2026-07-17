/**
 * Single AiFlow run detail: the run row + its step timeline. Owner-only.
 * Query: ?businessId=...
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getAiFlowRun, listAiFlowRunSteps } from "@/lib/ai-flows/db";
import { listSmsLinksForRun } from "@/lib/db/sms-links";

const idSchema = z.string().uuid();

type Ctx = { params: Promise<{ runId: string }> };

export async function GET(request: Request, { params }: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { runId } = await params;
    if (!idSchema.safeParse(runId).success) {
      return errorResponse("VALIDATION_ERROR", "runId is invalid");
    }
    const url = new URL(request.url);
    const businessId = url.searchParams.get("businessId");
    if (!businessId || !idSchema.safeParse(businessId).success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }
    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_aiflows");
    const run = await getAiFlowRun(businessId, runId);
    if (!run) return errorResponse("NOT_FOUND", "Run not found");
    const [steps, links] = await Promise.all([
      listAiFlowRunSteps(businessId, runId),
      // Tracked links are supplementary: a links/clicks read error must not
      // take down the step timeline the page is actually for.
      listSmsLinksForRun(businessId, runId, { includeClicks: true }).catch(() => [])
    ]);
    return successResponse({ run, steps, links });
  } catch (err) {
    return handleRouteError(err);
  }
}
