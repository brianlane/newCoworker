/**
 * Polling endpoint for one chat job's status.
 *
 * GET    serialize the requested dashboard_chat_jobs row (status,
 *        assistantMessageId, errorCode, ...). Used by the client to
 *        observe when the VPS chat-worker has finished generating —
 *        the path that replaces the Vercel-side NDJSON stream we
 *        deleted in PR #79.
 *
 * Why polling instead of Supabase Realtime on dashboard_chat_messages:
 *   - dashboard_chat_messages has RLS enabled with no SELECT policy
 *     for `authenticated`. Wiring up Realtime needs its own RLS audit
 *     (every existing read goes through service-role server code) and
 *     would balloon this PR's review surface.
 *   - Polling at ~1.5s is indistinguishable UX-wise once Rowboat's
 *     5-30s wall-clock dominates, and is naturally resilient to
 *     websocket disconnects (browser tab backgrounded, mobile network
 *     drop) that would otherwise need explicit reconnection logic.
 *   - The cost is negligible: each poll is one indexed PK lookup
 *     (the worker writes `status` in O(1)). At one polling client per
 *     in-flight job, this is far less load than the prior streaming
 *     path which held an open Vercel function for the whole window.
 *
 * Wire shape (data envelope only — error envelope is the standard
 * { ok:false, error:{ code, message } } shape):
 *   {
 *     "id": "uuid",
 *     "threadId": "uuid",
 *     "userMessageId": 123,
 *     "status": "queued" | "processing" | "done" | "error",
 *     "assistantMessageId": 124 | null,
 *     "errorCode": "rowboat_http_500" | null,
 *     "errorDetail": "..." | null,
 *     "createdAt": "...",
 *     "startedAt": "..." | null,
 *     "completedAt": "..." | null
 *   }
 *
 * Auth: getAuthUser + requireOwner(job.business_id). IDOR-safe — same
 * pattern as the per-thread messages route: resolve the row, then
 * gate ownership against the row's tenant.
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  getChatJobById,
  serializeChatJobStatus
} from "@/lib/db/dashboard-chat-jobs";

export const dynamic = "force-dynamic";

const jobIdSchema = z.string().uuid();

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { jobId: rawJobId } = await context.params;
    const jobId = jobIdSchema.parse(rawJobId);

    const job = await getChatJobById(jobId);
    if (!job) return errorResponse("NOT_FOUND", "Job not found");

    // IDOR: gate ownership against the row's business_id, never a
    // caller-supplied parameter. A stolen jobId paired with an owned
    // businessId in a query param could otherwise read another
    // tenant's job state.
    if (!user.isAdmin) await requireOwner(job.business_id);

    return successResponse(serializeChatJobStatus(job));
  } catch (err) {
    return handleRouteError(err);
  }
}
