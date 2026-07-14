/**
 * Owner-scoped SMS thread read endpoint.
 *
 * GET /api/dashboard/messages/:customerE164?businessId=<uuid>
 *   → { customerE164, messages } or 404 when no thread exists.
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "operate_messages"). Non-admin callers cannot
 * read texts for another business. Admins (per existing dashboard-chat
 * convention) may query any businessId without the ownership check.
 *
 * Why this exists alongside the page-level read:
 *   The page server-renders for the initial paint; this JSON endpoint
 *   exists for client-side polling/refresh and to keep contract tests
 *   honest (matches the calls/transcript pair).
 *
 * DELETE /api/dashboard/messages/:customerE164?businessId=<uuid> → { ok: true }
 *   Removes the whole conversation with that number from the owner's view.
 *   Soft delete under the hood (admin-restorable via
 *   /api/admin/deleted-items) but behaves like a hard delete here:
 *   idempotent, and the thread never surfaces again. The contact row is
 *   untouched — it has its own delete on the customers page.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { listMessagesForCustomer, softDeleteSmsConversation } from "@/lib/db/sms-history";

export const dynamic = "force-dynamic";

const SMS_THREAD_RATE = { interval: 60 * 1000, maxRequests: 60 };
const DELETE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const paramsSchema = z.object({
  // E.164 or a bare short code — short-code lead sources (ReferralExchange
  // = 73339) have readable threads too.
  customerE164: z.string().regex(/^(\+[1-9]\d{6,15}|\d{3,8})$/)
});

const querySchema = z.object({
  businessId: z.string().uuid()
});

export async function GET(
  request: Request,
  ctx: { params: Promise<{ customerE164: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const raw = (await ctx.params).customerE164;
    // Next decodes path segments, but if the link upstream was double-
    // encoded the `%2B` would arrive as a literal `+` already and the
    // second decodeURIComponent throws — guard so we always 400 instead
    // of 500.
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    const { customerE164 } = paramsSchema.parse({ customerE164: decoded });

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const limiter = rateLimit(
      `dashboard-messages:${businessId}:${user.userId}`,
      SMS_THREAD_RATE
    );
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, please slow down.", 429);
    }

    const messages = await listMessagesForCustomer(businessId, customerE164, {
      limit: 100
    });
    if (messages.length === 0) {
      return errorResponse("NOT_FOUND", "No thread for this customer");
    }

    return successResponse({
      customerE164,
      messages: messages.map((m) => ({
        id: m.id,
        jobId: m.jobId,
        direction: m.direction,
        content: m.content,
        timestamp: m.timestamp,
        status: m.status,
        lastError: m.lastError
      }))
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ customerE164: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const raw = (await ctx.params).customerE164;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    const { customerE164 } = paramsSchema.parse({ customerE164: decoded });

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const limiter = rateLimit(`dashboard-messages-delete:${businessId}`, DELETE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many deletes, slow down.", 429);
    }

    // Delete-if-exists semantics: ok even when the thread is already gone so
    // flaky-network retries never surface an error for a completed delete.
    await softDeleteSmsConversation(businessId, customerE164, user.userId);
    return successResponse({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
