/**
 * Stop a non-terminal AiFlow run. Owner-only.
 * Cancelable states: queued / running / awaiting_approval / awaiting_agent /
 * awaiting_reply / awaiting_call → `canceled` (nothing further sends; no
 * resume path picks a canceled run back up). A `running` run cancels
 * cooperatively — the worker
 * quits at the next step boundary, so the step in flight completes. Terminal
 * runs return CONFLICT.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { cancelAiFlowRun } from "@/lib/ai-flows/db";

const idSchema = z.string().uuid();

const bodySchema = z.object({
  businessId: z.string().uuid()
});

type Ctx = { params: Promise<{ runId: string }> };

export async function POST(request: Request, { params }: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { runId } = await params;
    if (!idSchema.safeParse(runId).success) {
      return errorResponse("VALIDATION_ERROR", "runId is invalid");
    }
    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_aiflows");
    const run = await cancelAiFlowRun({
      businessId: body.businessId,
      runId,
      canceledBy: user.userId ?? null
    });
    return successResponse(run);
  } catch (err) {
    if (err instanceof Error && /cannot be stopped|run not found/.test(err.message)) {
      return errorResponse("CONFLICT", err.message);
    }
    return handleRouteError(err);
  }
}
