/**
 * Owner-scoped voice call transcript read endpoint.
 *
 * GET /api/dashboard/calls/:callControlId?businessId=<uuid>
 *   → { transcript, turns } or 404 when the call doesn't belong to the caller.
 *
 * Auth: getAuthUser + requireOwner(businessId). Non-admin callers cannot read
 * transcripts for another business. Admins (per existing dashboard-chat
 * convention) may query any businessId without the ownership check.
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  getTranscriptByCallControlId,
  listTurns
} from "@/lib/db/voice-transcripts";

export const dynamic = "force-dynamic";

const CALL_TRANSCRIPT_RATE = { interval: 60 * 1000, maxRequests: 60 };

const paramsSchema = z.object({
  callControlId: z.string().trim().min(1).max(128)
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

    const { callControlId } = paramsSchema.parse(await ctx.params);

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireOwner(businessId);

    const limiter = rateLimit(
      `dashboard-calls:${businessId}:${user.userId}`,
      CALL_TRANSCRIPT_RATE
    );
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, please slow down.", 429);
    }

    const transcript = await getTranscriptByCallControlId(businessId, callControlId);
    if (!transcript) {
      return errorResponse("NOT_FOUND", "Transcript not found");
    }
    const turns = await listTurns(transcript.id);

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
