/**
 * Agents — single-agent management.
 *
 *   PATCH  /api/dashboard/agents/:agentId  → edit name / instructions / format / enabled
 *   DELETE /api/dashboard/agents/:agentId  → remove the agent (runs cascade)
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  deleteBusinessAgent,
  getBusinessAgent,
  listAgentRunInputPaths,
  patchBusinessAgent,
  type BusinessAgentPatch
} from "@/lib/agents/db";
import { AGENT_INSTRUCTIONS_MAX_CHARS, AGENT_NAME_MAX_CHARS } from "@/lib/agents/core";
import { BUSINESS_DOCS_BUCKET } from "@/lib/documents/core";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  businessId: z.string().uuid(),
  // trim() BEFORE min(1) so whitespace-only input is rejected, not persisted
  // as an empty string.
  name: z.string().trim().min(1).max(AGENT_NAME_MAX_CHARS).optional(),
  instructions: z.string().trim().min(1).max(AGENT_INSTRUCTIONS_MAX_CHARS).optional(),
  outputFormat: z.enum(["markdown", "same_as_input"]).optional(),
  enabled: z.boolean().optional()
});

type RouteContext = { params: Promise<{ agentId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const { agentId } = await context.params;
    if (!z.string().uuid().safeParse(agentId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid agent id");
    }
    const body = patchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse("VALIDATION_ERROR", body.error.issues[0]?.message ?? "Invalid body");
    }
    if (!user.isAdmin) await requireBusinessRole(body.data.businessId, "manage_aiflows");

    const existing = await getBusinessAgent(body.data.businessId, agentId);
    if (!existing) return errorResponse("NOT_FOUND", "Agent not found", 404);

    const patch: BusinessAgentPatch = {};
    if (body.data.name !== undefined) patch.name = body.data.name;
    if (body.data.instructions !== undefined) patch.instructions = body.data.instructions;
    if (body.data.outputFormat !== undefined) patch.output_format = body.data.outputFormat;
    if (body.data.enabled !== undefined) patch.enabled = body.data.enabled;
    if (Object.keys(patch).length === 0) {
      return errorResponse("VALIDATION_ERROR", "Nothing to update");
    }

    await patchBusinessAgent(body.data.businessId, agentId, patch);
    const updated = await getBusinessAgent(body.data.businessId, agentId);
    return successResponse({ agent: updated });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    const { agentId } = await context.params;
    if (!z.string().uuid().safeParse(agentId).success) {
      return errorResponse("VALIDATION_ERROR", "Invalid agent id");
    }
    const businessId = z
      .string()
      .uuid()
      .safeParse(new URL(request.url).searchParams.get("businessId"));
    if (!businessId.success) return errorResponse("VALIDATION_ERROR", "businessId is required");
    if (!user.isAdmin) await requireBusinessRole(businessId.data, "manage_aiflows");

    const existing = await getBusinessAgent(businessId.data, agentId);
    if (!existing) return errorResponse("NOT_FOUND", "Agent not found", 404);

    // Collect archived run inputs BEFORE the delete (runs cascade with the
    // agent row), then best-effort remove them so the bucket doesn't
    // accumulate invisible garbage.
    const inputPaths = await listAgentRunInputPaths(businessId.data, agentId).catch(() => []);
    await deleteBusinessAgent(businessId.data, agentId);
    if (inputPaths.length > 0) {
      const db = await createSupabaseServiceClient();
      const { error: removeError } = await db.storage
        .from(BUSINESS_DOCS_BUCKET)
        .remove(inputPaths);
      if (removeError) {
        logger.warn("agents/delete: run input cleanup failed", {
          businessId: businessId.data,
          agentId,
          error: removeError.message
        });
      }
    }
    return successResponse({ deleted: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
