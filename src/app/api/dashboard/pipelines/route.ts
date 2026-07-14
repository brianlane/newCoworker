/**
 * Pipeline boards (GoHighLevel-style; stages are backed by contact tags).
 *
 * GET  /api/dashboard/pipelines?businessId=<uuid>
 *        → { pipelines: Pipeline[] } (stages ordered)
 *
 * POST /api/dashboard/pipelines?businessId=<uuid>
 *        body: { name, stages: [{name, color?}] } — custom pipeline
 *          or  { seedDefault: true }              — the starter "Leads" board
 *        → { pipeline }
 *
 * Auth: viewing needs view_dashboard (staff work the board); creating needs
 * manage_settings (manager+), same bar as the rest of business config.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createPipeline, listPipelines, PipelineError } from "@/lib/pipelines/db";
import {
  DEFAULT_PIPELINE,
  MAX_PIPELINE_NAME_LENGTH,
  MAX_STAGE_NAME_LENGTH,
  MAX_STAGES_PER_PIPELINE
} from "@/lib/pipelines/types";

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };
const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const querySchema = z.object({ businessId: z.string().uuid() });

const createBodySchema = z.union([
  z.object({ seedDefault: z.literal(true) }),
  z.object({
    name: z.string().trim().min(1).max(MAX_PIPELINE_NAME_LENGTH),
    stages: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(MAX_STAGE_NAME_LENGTH),
          color: z.string().max(20).optional()
        })
      )
      .min(1)
      .max(MAX_STAGES_PER_PIPELINE)
  })
]);

/** Map a typed lib failure onto the right HTTP class (route-local; Next
 * route modules may only export handlers). */
function pipelineErrorResponse(err: PipelineError) {
  if (err.code === "not_found") return errorResponse("NOT_FOUND", err.message);
  return errorResponse("VALIDATION_ERROR", err.message);
}

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });
    if (!user.isAdmin) await requireBusinessRole(businessId, "view_dashboard");

    const limiter = rateLimit(`pipelines:${businessId}:${user.userId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    return successResponse({ pipelines: await listPipelines(businessId) });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });
    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

    const limiter = rateLimit(`pipelines-write:${businessId}:${user.userId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many edits, slow down.", 429);
    }

    const body = createBodySchema.parse(await request.json());
    const input =
      "seedDefault" in body
        ? DEFAULT_PIPELINE
        : { name: body.name, stages: body.stages };

    try {
      const pipeline = await createPipeline(businessId, input.name, input.stages);
      return successResponse({ pipeline });
    } catch (err) {
      if (err instanceof PipelineError) return pipelineErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
