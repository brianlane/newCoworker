import { parseClawLog, evaluateUrgency } from "@/lib/claw/logs";
import { insertCoworkerLog } from "@/lib/db/logs";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { randomUUID } from "crypto";
import { verifyRowboatGatewayToken } from "@/lib/rowboat/gateway-token";

export async function POST(request: Request) {
  if (!verifyRowboatGatewayToken(request)) {
    return errorResponse("UNAUTHORIZED", "Invalid gateway token", 401);
  }

  try {
    const payload = await request.json();
    const log = parseClawLog(payload);
    const urgency = evaluateUrgency(log);

    // Write log to DB
    const logId = randomUUID();
    await insertCoworkerLog({
      id: logId,
      business_id: log.businessId,
      task_type: log.taskType,
      status: log.status,
      log_payload: log.logPayload
    });

    // Fire notifications for urgent events. The dispatcher resolves per-business
    // preferences (alert_email/phone_number, four channel toggles, unsubscribed_at)
    // and writes one `notifications` row per channel — sent, failed, or skipped —
    // so the dashboard "Recent notifications" list is the source of truth.
    if (urgency.shouldNotify) {
      try {
        await dispatchUrgentNotification({
          businessId: log.businessId,
          summary: urgency.summary,
          kind: "urgent_alert",
          payload: { logId, taskType: log.taskType }
        });
      } catch (err) {
        logger.warn("Urgent notification dispatch failed", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return successResponse({ logId, urgency });
  } catch (err) {
    return handleRouteError(err);
  }
}
