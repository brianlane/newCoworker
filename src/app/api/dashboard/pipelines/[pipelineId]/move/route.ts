/**
 * Move a contact between a pipeline's stages (the drag-and-drop endpoint).
 *
 * POST /api/dashboard/pipelines/:pipelineId/move?businessId=<uuid>
 *   body: { contactE164, stageId }        — move into that stage
 *         { contactE164, stageId: null }  — take the contact off the board
 *   → { tags, added, removed, droppedAtCap }
 *
 * Stage = tag, so the move is one tag transition: strip every stage tag of
 * THIS pipeline, add the target's. It fires the exact same automation hooks
 * as the dashboard tag editor (goal events for added tags; tag_changed
 * contact events for adds AND removals), so flows chained on stage tags run
 * whether the lead was moved by an AiFlow or by a human dragging the card.
 *
 * Auth: operate_messages — staff work the board, same bar as editing a
 * contact's tags from its profile page.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { listPipelines } from "@/lib/pipelines/db";
import { computeStageMove } from "@/lib/pipelines/move";
import { getCustomerMemory, updateCustomerOwnerFields } from "@/lib/customer-memory/db";
import { fireGoalEvent } from "@/lib/ai-flows/goal-hooks";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";

export const dynamic = "force-dynamic";

const MOVE_RATE = { interval: 60 * 1000, maxRequests: 60 };

const querySchema = z.object({ businessId: z.string().uuid() });
const paramsSchema = z.object({ pipelineId: z.string().uuid() });
const bodySchema = z.object({
  // E.164 or a 3-8 digit short code, matching the contacts routes.
  contactE164: z.string().regex(/^(\+[1-9]\d{6,15}|\d{3,8})$/),
  stageId: z.string().uuid().nullable()
});

export async function POST(
  request: Request,
  ctx: { params: Promise<{ pipelineId: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { pipelineId } = paramsSchema.parse({
      pipelineId: (await ctx.params).pipelineId
    });
    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });
    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const limiter = rateLimit(`pipeline-move:${businessId}:${user.userId}`, MOVE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many moves, slow down.", 429);
    }

    const body = bodySchema.parse(await request.json());

    const pipeline = (await listPipelines(businessId)).find((p) => p.id === pipelineId);
    if (!pipeline) return errorResponse("NOT_FOUND", "Pipeline not found");
    const target = body.stageId
      ? pipeline.stages.find((s) => s.id === body.stageId)
      : null;
    if (body.stageId && !target) {
      return errorResponse("VALIDATION_ERROR", "That stage is not on this pipeline");
    }

    // Alias-aware: the board may show a merged-away number; resolve to the
    // surviving profile and write against its PRIMARY (same subtlety as the
    // contact PATCH route).
    const existing = await getCustomerMemory(businessId, body.contactE164);
    if (!existing) return errorResponse("NOT_FOUND", "Contact not found");
    const canonicalE164 = existing.customer_e164;

    const delta = computeStageMove(
      existing.tags ?? [],
      pipeline.stages.map((s) => s.name),
      target?.name ?? null
    );

    if (delta.added.length === 0 && delta.removed.length === 0) {
      // Already in the target stage (or off-board with no stage tags).
      return successResponse({
        tags: delta.nextTags,
        added: [],
        removed: [],
        droppedAtCap: delta.droppedAtCap
      });
    }

    await updateCustomerOwnerFields(businessId, canonicalE164, {
      tags: delta.nextTags
    });

    // Same hooks as the dashboard tag editor: goal events may fast-forward
    // parked runs; tag_changed events may start flows watching the change.
    // Best-effort inside both hooks — a trigger failure never fails the move.
    const eventStamp = Date.now();
    const goalNumbers = [canonicalE164, ...(existing.alias_e164s ?? [])];
    for (const tag of delta.added) {
      for (const number of goalNumbers) {
        await fireGoalEvent(businessId, number, { kind: "tag_added", tag });
      }
      await fireContactEvent(businessId, {
        kind: "tag_changed",
        contact: { e164: canonicalE164, tags: delta.nextTags },
        tag,
        change: "added",
        dedupeKey: `ce:tag:${canonicalE164}:${tag.toLowerCase()}:added:${eventStamp}`
      });
    }
    for (const tag of delta.removed) {
      await fireContactEvent(businessId, {
        kind: "tag_changed",
        contact: { e164: canonicalE164, tags: delta.nextTags },
        tag,
        change: "removed",
        dedupeKey: `ce:tag:${canonicalE164}:${tag.toLowerCase()}:removed:${eventStamp}`
      });
    }

    return successResponse({
      tags: delta.nextTags,
      added: delta.added,
      removed: delta.removed,
      droppedAtCap: delta.droppedAtCap
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
