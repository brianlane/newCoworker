/**
 * Admin view + restore of owner-soft-deleted content (the flip side of the
 * owner delete actions, which look like hard deletes on the dashboard).
 *
 * GET  /api/admin/deleted-items?businessId=<uuid>
 *        → { items: DeletedItem[] } — newest deletion first, SMS rows folded
 *          into one entry per conversation.
 * POST /api/admin/deleted-items
 *        body { businessId, type, id, action: "restore" }
 *        → { restored } — clears the stamp (central + box for residency
 *          tenants); the item instantly reappears for the owner. Audited to
 *          coworker_logs.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { listDeletedItems, restoreDeletedItem } from "@/lib/admin/deleted-items";
import { insertCoworkerLog } from "@/lib/db/logs";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const querySchema = z.object({ businessId: z.string().uuid() });

const restoreSchema = z.object({
  businessId: z.string().uuid(),
  action: z.literal("restore"),
  type: z.enum(["notification", "email", "call", "sms_conversation", "chat_thread"]),
  // Row uuid, or the conversation's E.164/short code for sms_conversation.
  id: z.string().min(1).max(64)
});

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      businessId: url.searchParams.get("businessId") ?? ""
    });
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId must be a uuid");
    }
    const items = await listDeletedItems(parsed.data.businessId);
    return successResponse({ items });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = restoreSchema.parse(await request.json());

    const { restored } = await restoreDeletedItem(body.businessId, body.type, body.id);

    // Audit the resurrection — an admin restoring tenant-deleted content
    // must be visible in the ops trail. Best-effort: the restore itself
    // already happened.
    try {
      await insertCoworkerLog({
        id: crypto.randomUUID(),
        business_id: body.businessId,
        task_type: "data_flow",
        status: "success",
        log_payload: {
          action: "deleted_item_restored",
          itemType: body.type,
          itemId: body.id,
          restoredRows: restored,
          restoredBy: admin.userId
        }
      });
    } catch (auditErr) {
      logger.error("deleted-items: audit log failed", {
        errorMessage: auditErr instanceof Error ? auditErr.message : String(auditErr)
      });
    }

    return successResponse({ restored });
  } catch (err) {
    return handleRouteError(err);
  }
}
