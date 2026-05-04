/**
 * Read-only messages for a single archived thread on /dashboard/chat.
 *
 * GET    return every message in the requested thread, in created_at
 *        order, after verifying the thread belongs to a business the
 *        caller owns.
 *
 * Why a separate route from `/api/dashboard/chat` (which already returns
 * messages):
 *   - That route is hardcoded to the *active* thread for sending; the
 *     sidebar needs the same UX for archived threads without changing
 *     the active-thread-or-create-one contract on POST.
 *   - Keeping read-only history in a distinct route lets us skip the
 *     write-side rate limit and Rowboat-readiness checks — neither is
 *     relevant when the model isn't being invoked.
 *
 * Auth: getAuthUser + requireOwner(thread.business_id). Anti-IDOR: we
 * MUST resolve the thread first, then enforce ownership against
 * `thread.business_id` rather than trusting any caller-supplied
 * businessId in the URL — otherwise an authenticated owner could page
 * through another tenant's threads by guessing UUIDs.
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  getThreadById,
  listMessages,
  serializeChatMessages
} from "@/lib/db/dashboard-chat";

export const dynamic = "force-dynamic";

const threadIdSchema = z.string().uuid();

export async function GET(
  _request: Request,
  context: { params: Promise<{ threadId: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { threadId: rawThreadId } = await context.params;
    const threadId = threadIdSchema.parse(rawThreadId);

    const thread = await getThreadById(threadId);
    if (!thread) return errorResponse("NOT_FOUND", "Conversation not found");

    // IDOR guard: enforce ownership against the row we just read, never
    // a caller-supplied parameter.
    if (!user.isAdmin) await requireOwner(thread.business_id);

    const messages = await listMessages(threadId);
    return successResponse({
      threadId: thread.id,
      title: thread.title,
      isActive: thread.is_active,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
      messages: serializeChatMessages(messages)
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
