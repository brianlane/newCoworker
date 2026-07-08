/**
 * Cancel a scheduled SMS (Standard/Enterprise perk).
 *
 * DELETE /api/dashboard/messages/schedule/:id  body { businessId }
 *
 * Only 'pending' rows can be canceled — once the sweep claims a row
 * ('sending') the Telnyx call may already be in flight, and 'sent' is final.
 * The status guard is part of the UPDATE's WHERE clause so a cancel racing
 * the sweep loses cleanly (404) instead of un-sending anything.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const deleteSchema = z.object({ businessId: z.string().uuid() });

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) {
      return errorResponse("VALIDATION_ERROR", "Scheduled message id must be a UUID");
    }

    const json = (await request.json().catch(() => null)) as unknown;
    const { businessId } = deleteSchema.parse(json);

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const db = await createSupabaseServiceClient();
    const { data, error } = await db
      .from("scheduled_sms")
      .update({ status: "canceled", error: "canceled_by_owner" })
      .eq("id", id)
      .eq("business_id", businessId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (error) return errorResponse("DB_ERROR", error.message);
    if (!data) {
      return errorResponse(
        "NOT_FOUND",
        "Scheduled message not found or already dispatched."
      );
    }

    return successResponse({ canceled: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
