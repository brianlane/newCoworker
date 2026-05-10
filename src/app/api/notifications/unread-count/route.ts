import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { getUnreadNotificationCount } from "@/lib/db/notifications";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";

/**
 * Lightweight endpoint the dashboard sidebar bell badge polls. Backed by the
 * partial index `notifications_business_unread_idx (business_id) WHERE
 * read_at IS NULL`, so the cost is O(unread) not O(total) per business.
 */
export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const url = new URL(request.url);
    const parsed = z.string().uuid().safeParse(url.searchParams.get("businessId"));
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }

    await requireOwner(parsed.data);
    const count = await getUnreadNotificationCount(parsed.data);
    return successResponse({ count });
  } catch (err) {
    return handleRouteError(err);
  }
}
