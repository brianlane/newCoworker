/**
 * Polling endpoint for one chat job's status.
 *
 * GET    serialize the requested dashboard_chat_jobs row (status,
 *        assistantMessageId, errorCode, ...). Used by the client to
 *        observe when the VPS chat-worker has finished generating —
 *        the path that replaces the Vercel-side NDJSON stream we
 *        deleted in PR #79.
 *
 * Polling alongside Realtime — why both:
 *   The browser primary path is Supabase Realtime on
 *   dashboard_chat_messages (gated by the SELECT policy added in
 *   migration 20260508000003). This polling endpoint is the
 *   belt-and-suspenders fallback for cases where Realtime can't
 *   deliver:
 *     - corporate proxies or mobile networks that block websockets,
 *     - the rare INSERT event drop on the way to the client,
 *     - worker error states (status='error') — Realtime fires only
 *       on assistant-message INSERT, not on a job's error transition,
 *     - the small race window where the user message INSERT lands
 *       before the subscription handshake completes.
 *   The client races both paths via Promise.race; first to settle
 *   wins. Per-poll cost is one indexed PK lookup, dwarfed by the
 *   prior streaming path's per-turn open Vercel function.
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
