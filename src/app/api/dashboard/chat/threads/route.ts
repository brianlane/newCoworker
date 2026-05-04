/**
 * Conversation history index for /dashboard/chat.
 *
 * GET    list every thread that's ever existed for the caller's business,
 *        newest activity first, with a denormalized message count so
 *        the sidebar can render "Started Apr 23 · 6 messages" without an
 *        N+1 fetch per thread.
 *
 * Auth: getAuthUser + requireOwner(businessId). Mirrors the parent
 * `/api/dashboard/chat` route — read-only here, no rate limiting (the
 * sidebar polls on mount + after each new conversation, not per-keystroke).
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  listThreadsForBusiness,
  type DashboardChatThreadSummary
} from "@/lib/db/dashboard-chat";

export const dynamic = "force-dynamic";

const businessIdSchema = z.string().uuid();

function businessIdFromUrl(request: Request): string {
  const url = new URL(request.url);
  const id = url.searchParams.get("businessId") ?? "";
  return businessIdSchema.parse(id);
}

function serializeThread(t: DashboardChatThreadSummary) {
  return {
    id: t.id,
    title: t.title,
    isActive: t.is_active,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    messageCount: t.message_count
  };
}

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const businessId = businessIdFromUrl(request);
    if (!user.isAdmin) await requireOwner(businessId);

    const threads = await listThreadsForBusiness(businessId);
    return successResponse({ threads: threads.map(serializeThread) });
  } catch (err) {
    return handleRouteError(err);
  }
}
