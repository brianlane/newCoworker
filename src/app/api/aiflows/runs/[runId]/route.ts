/**
 * Single AiFlow run detail: the run row + its step timeline. Owner-only.
 * Query: ?businessId=...
 */
import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getAiFlowRun, listAiFlowRunSteps } from "@/lib/ai-flows/db";

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
    if (!user.isAdmin) await requireOwner(businessId);
    const run = await getAiFlowRun(businessId, runId);
    if (!run) return errorResponse("NOT_FOUND", "Run not found");
    const steps = await listAiFlowRunSteps(businessId, runId);
    return successResponse({ run, steps });
  } catch (err) {
    return handleRouteError(err);
  }
}
