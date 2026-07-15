/**
 * Per-thread management for /dashboard/chat's conversation history.
 *
 * DELETE /api/dashboard/chat/threads/:threadId → { ok: true }
 *   Removes the thread (and, transitively, its messages — they are only
 *   reachable through the thread) from the owner's view. Soft delete under
 *   the hood (admin-restorable via /api/admin/deleted-items) but behaves
 *   like a hard delete here: idempotent, and the thread never surfaces
 *   again. Deleting the ACTIVE thread also deactivates it, so the next
 *   message simply starts a fresh conversation.
 *
 * Auth mirrors the read-only messages route next door: resolve the thread
 * first, then enforce ownership against `thread.business_id` (anti-IDOR) —
 * the soft-delete update additionally predicates on business_id so a
 * guessed UUID can never touch a foreign tenant's thread.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { getThreadById, softDeleteThread } from "@/lib/db/dashboard-chat";

export const dynamic = "force-dynamic";

const threadIdSchema = z.string().uuid();

const DELETE_RATE = { interval: 60 * 1000, maxRequests: 30 };

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ threadId: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { threadId: rawThreadId } = await context.params;
    const threadId = threadIdSchema.parse(rawThreadId);

    // Already-deleted/unknown threads read back as null — that's a
    // successful idempotent delete, not an error.
    const thread = await getThreadById(threadId);
    if (!thread) return successResponse({ ok: true });

    // IDOR guard: enforce ownership against the row we just read, never a
    // caller-supplied parameter.
    if (!user.isAdmin) await requireBusinessRole(thread.business_id, "operate_messages");

    const limiter = rateLimit(`chat-thread-delete:${thread.business_id}`, DELETE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many deletes, slow down.", 429);
    }

    await softDeleteThread(thread.business_id, threadId, user.userId);
    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
