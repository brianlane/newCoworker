/**
 * Approve / deny an AiFlow run paused at an approval_gate. Owner-only.
 * Approve → run returns to `queued` (worker resumes); deny → `canceled`.
 */
import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { decideAiFlowApproval } from "@/lib/ai-flows/db";

const idSchema = z.string().uuid();

const bodySchema = z.object({
  businessId: z.string().uuid(),
  decision: z.enum(["approve", "deny"]),
  note: z.string().max(500).optional()
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
    if (!user.isAdmin) await requireOwner(body.businessId);
    const run = await decideAiFlowApproval({
      businessId: body.businessId,
      runId,
      decision: body.decision,
      decidedBy: user.userId ?? null,
      note: body.note
    });
    return successResponse(run);
  } catch (err) {
    if (err instanceof Error && /not awaiting approval|run not found/.test(err.message)) {
      return errorResponse("CONFLICT", err.message);
    }
    return handleRouteError(err);
  }
}
