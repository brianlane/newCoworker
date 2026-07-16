/**
 * Agents — save a run's artifact into the Documents knowledge library.
 *
 *   POST /api/dashboard/agents/runs/:runId/save-document
 *        { businessId, title? }
 *
 * Thin auth/validation wrapper around saveAgentRunArtifact (shared with the
 * run_agent flow step's filing path). Saved documents default to the
 * 'staff' audience so a generated artifact can never leak to customer
 * channels unless the owner deliberately widens it.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getAgentRun, getBusinessAgent } from "@/lib/agents/db";
import { saveAgentRunArtifact } from "@/lib/agents/save-artifact";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  title: z.string().min(1).max(200).optional()
});

type RouteContext = { params: Promise<{ runId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const { runId } = await context.params;
    if (!z.string().uuid().safeParse(runId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid run id");
    }
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    // Saving into the knowledge library is a settings-level change, same
    // gate as uploading a document directly.
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_settings");

    const run = await getAgentRun(body.data.businessId, runId);
    if (!run) return errorResponse("NOT_FOUND", "Run not found", 404);
    if (run.status !== "succeeded" || !run.output_md) {
      return errorResponse("VALIDATION_ERROR", "This run has no output to save");
    }

    const agent = await getBusinessAgent(body.data.businessId, run.agent_id);
    const saved = await saveAgentRunArtifact({
      businessId: body.data.businessId,
      run,
      agentName: agent?.name ?? "Agent",
      title: body.data.title,
      audience: "staff"
    });
    if (!saved.ok) {
      if (saved.error === "business_not_found") {
        return errorResponse("NOT_FOUND", saved.detail, 404);
      }
      if (saved.error === "storage_failed") {
        return errorResponse("INTERNAL_SERVER_ERROR", saved.detail);
      }
      return errorResponse("VALIDATION_ERROR", saved.detail);
    }

    return successResponse({ document: saved.document });
  } catch (err) {
    return handleRouteError(err);
  }
}
