import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead
} from "@/lib/db/notifications";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";

/**
 * GET /api/notifications?businessId=...&limit=25&unreadOnly=1
 *   Returns the most recent notifications for the owner's business.
 *
 * POST /api/notifications
 *   Body shape A: { businessId, action: "mark_read", id }
 *   Body shape B: { businessId, action: "mark_all_read" }
 */

const listQuerySchema = z.object({
  businessId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  unreadOnly: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional()
});

const markReadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("mark_read"),
    businessId: z.string().uuid(),
    id: z.string().uuid()
  }),
  z.object({
    action: z.literal("mark_all_read"),
    businessId: z.string().uuid()
  })
]);

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const url = new URL(request.url);
    const parsed = listQuerySchema.safeParse({
      businessId: url.searchParams.get("businessId") ?? "",
      limit: url.searchParams.get("limit") ?? undefined,
      unreadOnly: url.searchParams.get("unreadOnly") ?? undefined
    });
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid query");
    }

    await requireOwner(parsed.data.businessId);

    const unreadOnly = parsed.data.unreadOnly === "1" || parsed.data.unreadOnly === "true";
    const items = await getNotifications(parsed.data.businessId, {
      limit: parsed.data.limit ?? 25,
      unreadOnly
    });
    return successResponse({ items });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const body = markReadSchema.parse(await request.json());
    await requireOwner(body.businessId);

    if (body.action === "mark_read") {
      const row = await markNotificationRead(body.id, body.businessId);
      return successResponse({ marked: row ? 1 : 0, notification: row });
    }
    const count = await markAllNotificationsRead(body.businessId);
    return successResponse({ marked: count });
  } catch (err) {
    return handleRouteError(err);
  }
}
