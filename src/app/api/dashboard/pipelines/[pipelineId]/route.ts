/**
 * Manage one pipeline board and its stages.
 *
 * PATCH /api/dashboard/pipelines/:pipelineId?businessId=<uuid>
 *   body (discriminated on `action`):
 *     { action: "rename",         name }
 *     { action: "add_stage",      stage: { name, color? } }
 *     { action: "update_stage",   stageId, name?, color? }   (rename retags contacts)
 *     { action: "reorder_stages", stageIds: [uuid, ...] }    (exact permutation)
 *     { action: "delete_stage",   stageId, destinationStageId? }
 *       — with a destination, contacts move there (GHL's "move opportunities
 *         to another stage"); without, they keep the now-unmapped tag.
 *
 * DELETE /api/dashboard/pipelines/:pipelineId?businessId=<uuid>
 *   Deletes the board (stages cascade); contacts keep their tags.
 *
 * Auth: manage_settings (manager+) — board administration, same bar as the
 * rest of business config. Bulk retags here deliberately do NOT fire
 * tag_changed automation (see src/lib/pipelines/db.ts); only the per-lead
 * move endpoint does.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  addStage,
  deletePipeline,
  deleteStage,
  renamePipeline,
  reorderStages,
  updateStage,
  PipelineError
} from "@/lib/pipelines/db";
import {
  MAX_PIPELINE_NAME_LENGTH,
  MAX_STAGE_NAME_LENGTH,
  MAX_STAGES_PER_PIPELINE
} from "@/lib/pipelines/types";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 30 };

const querySchema = z.object({ businessId: z.string().uuid() });
const paramsSchema = z.object({ pipelineId: z.string().uuid() });

const stageNameSchema = z.string().trim().min(1).max(MAX_STAGE_NAME_LENGTH);

const patchBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("rename"),
    name: z.string().trim().min(1).max(MAX_PIPELINE_NAME_LENGTH)
  }),
  z.object({
    action: z.literal("add_stage"),
    stage: z.object({ name: stageNameSchema, color: z.string().max(20).optional() })
  }),
  z.object({
    action: z.literal("update_stage"),
    stageId: z.string().uuid(),
    name: stageNameSchema.optional(),
    color: z.string().max(20).optional()
  }),
  z.object({
    action: z.literal("reorder_stages"),
    stageIds: z.array(z.string().uuid()).min(1).max(MAX_STAGES_PER_PIPELINE)
  }),
  z.object({
    action: z.literal("delete_stage"),
    stageId: z.string().uuid(),
    destinationStageId: z.string().uuid().optional()
  })
]);

/** Map a typed lib failure onto the right HTTP class (route-local). */
function pipelineErrorResponse(err: PipelineError) {
  if (err.code === "not_found") return errorResponse("NOT_FOUND", err.message);
  return errorResponse("VALIDATION_ERROR", err.message);
}

async function authorize(request: Request, rawPipelineId: string) {
  const user = await getAuthUser();
  if (!user) return { error: errorResponse("UNAUTHORIZED", "Authentication required") };

  const { pipelineId } = paramsSchema.parse({ pipelineId: rawPipelineId });
  const url = new URL(request.url);
  const { businessId } = querySchema.parse({
    businessId: url.searchParams.get("businessId") ?? ""
  });
  if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

  const limiter = rateLimit(`pipelines-manage:${businessId}:${user.userId}`, WRITE_RATE);
  if (!limiter.success) {
    return { error: errorResponse("CONFLICT", "Too many edits, slow down.", 429) };
  }
  return { businessId, pipelineId };
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ pipelineId: string }> }
) {
  try {
    const auth = await authorize(request, (await ctx.params).pipelineId);
    if ("error" in auth) return auth.error;
    const { businessId, pipelineId } = auth;

    const body = patchBodySchema.parse(await request.json());
    try {
      switch (body.action) {
        case "rename": {
          await renamePipeline(businessId, pipelineId, body.name);
          return successResponse({ ok: true });
        }
        case "add_stage": {
          const stage = await addStage(businessId, pipelineId, body.stage);
          return successResponse({ stage });
        }
        case "update_stage": {
          const result = await updateStage(businessId, body.stageId, {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.color !== undefined ? { color: body.color } : {})
          });
          return successResponse(result);
        }
        case "reorder_stages": {
          await reorderStages(businessId, pipelineId, body.stageIds);
          return successResponse({ ok: true });
        }
        case "delete_stage": {
          const result = await deleteStage(
            businessId,
            body.stageId,
            body.destinationStageId ?? null
          );
          return successResponse(result);
        }
      }
    } catch (err) {
      if (err instanceof PipelineError) return pipelineErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ pipelineId: string }> }
) {
  try {
    const auth = await authorize(request, (await ctx.params).pipelineId);
    if ("error" in auth) return auth.error;
    const { businessId, pipelineId } = auth;

    try {
      await deletePipeline(businessId, pipelineId);
      return successResponse({ ok: true });
    } catch (err) {
      if (err instanceof PipelineError) return pipelineErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
