/**
 * Cancel a scheduled SMS (Standard/Enterprise perk).
 *
 * DELETE /api/dashboard/messages/schedule/:id  body { businessId }
 *
 * Only 'pending' rows can be canceled, once the sweep claims a row
 * ('sending') the Telnyx call may already be in flight, and 'sent' is final.
 * The status guard is part of the UPDATE's WHERE clause so a cancel racing
 * the sweep loses cleanly (404) instead of un-sending anything.
 *
 * Cancelling one the TEXTING COWORKER queued also has to retract its pinned
 * note. schedule_text pins "wants a text at ..." onto the contact, and pinned
 * notes ride every later SMS turn, so a cancel that only flips the row leaves
 * the coworker reading a standing promise for a send the owner deliberately
 * dropped, and it would happily queue a replacement.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { appendCustomerPinnedNote } from "@/lib/customer-tools/handlers";
import { formatBookingStartLocal } from "@/lib/calendar-tools/handlers";
import { getBusinessTimezone } from "@/lib/db/businesses";
import { logger } from "@/lib/logger";

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
      .select("id, to_e164, send_at, created_by")
      .maybeSingle();
    if (error) return errorResponse("DB_ERROR", error.message);
    if (!data) {
      return errorResponse(
        "NOT_FOUND",
        "Scheduled message not found or already dispatched."
      );
    }

    // Retract the coworker's pin, best-effort: the cancel itself already
    // landed, and a note failure must not report it as unsuccessful.
    const row = data as { to_e164: string; send_at: string; created_by: string | null };
    if (row.created_by === "sms_coworker") {
      try {
        const timezone = (await getBusinessTimezone(businessId, db)) ?? "UTC";
        await appendCustomerPinnedNote(
          businessId,
          row.to_e164,
          "The reminder text queued for " +
            `${formatBookingStartLocal(row.send_at, timezone)} was canceled here; ` +
            "it is no longer going out. Do not re-queue it unless they ask again.",
          "sms",
          "dashboard"
        );
      } catch (err) {
        logger.warn("scheduled sms cancel: pin retraction failed", { id, err });
      }
    }

    return successResponse({ canceled: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
