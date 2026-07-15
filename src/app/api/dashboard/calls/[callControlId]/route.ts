/**
 * Owner-scoped voice call transcript read endpoint.
 *
 * GET /api/dashboard/calls/:callControlId?businessId=<uuid>
 *   → { transcript, turns } or 404 when the call doesn't belong to the caller.
 *
 * DELETE /api/dashboard/calls/:callControlId?businessId=<uuid> → { ok: true }
 *   Removes the call (transcript + turns) from the owner's view. Soft delete
 *   under the hood (admin-restorable via /api/admin/deleted-items) but
 *   behaves like a hard delete here: idempotent, never surfaces again.
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "operate_messages"). Non-admin callers cannot read
 * transcripts for another business. Admins (per existing dashboard-chat
 * convention) may query any businessId without the ownership check.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  getTranscriptById,
  listTurns,
  softDeleteTranscript
} from "@/lib/db/voice-transcripts";

export const dynamic = "force-dynamic";

const CALL_TRANSCRIPT_RATE = { interval: 60 * 1000, maxRequests: 60 };
const DELETE_RATE = { interval: 60 * 1000, maxRequests: 30 };

// Route segment is `callControlId` for backward-compatibility, but the
// URL value is the transcript row UUID — see the list-page link for the
// rationale around `:`-in-callControlId routing breakage.
const paramsSchema = z.object({
  callControlId: z.string().trim().uuid()
});

const querySchema = z.object({
  businessId: z.string().uuid()
});

export async function GET(
  request: Request,
  ctx: { params: Promise<{ callControlId: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { callControlId: transcriptId } = paramsSchema.parse(await ctx.params);

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const limiter = rateLimit(
      `dashboard-calls:${businessId}:${user.userId}`,
      CALL_TRANSCRIPT_RATE
    );
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, please slow down.", 429);
    }

    const transcript = await getTranscriptById(businessId, transcriptId);
    if (!transcript) {
      return errorResponse("NOT_FOUND", "Transcript not found");
    }
    const turns = await listTurns(transcript.id, { businessId });

    return successResponse({
      transcript: {
        id: transcript.id,
        callControlId: transcript.call_control_id,
        callerE164: transcript.caller_e164,
        model: transcript.model,
        status: transcript.status,
        startedAt: transcript.started_at,
        endedAt: transcript.ended_at
      },
      turns: turns.map((t) => ({
        id: t.id,
        role: t.role,
        content: t.content,
        turnIndex: t.turn_index,
        createdAt: t.created_at
      }))
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ callControlId: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { callControlId: transcriptId } = paramsSchema.parse(await ctx.params);

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const limiter = rateLimit(`dashboard-calls-delete:${businessId}`, DELETE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many deletes, slow down.", 429);
    }

    // Delete-if-exists semantics: ok even when the row is already gone so
    // flaky-network retries never surface an error for a completed delete.
    await softDeleteTranscript(businessId, transcriptId, user.userId);
    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
