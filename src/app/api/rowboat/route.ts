import { parseClawLog, evaluateUrgency } from "@/lib/claw/logs";
import { insertCoworkerLog } from "@/lib/db/logs";
import { recordSystemLog } from "@/lib/db/system-logs";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { randomUUID } from "crypto";
import { after } from "next/server";
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

    // Mirror into the unified system_logs stream: this gateway is how the
    // VPS-side agent reports task outcomes, so error statuses here are
    // exactly the "client ran an AI and it broke" signal the admin view needs.
    // Deferred via after() so the VPS claw-log request never waits on it.
    after(() =>
      recordSystemLog({
        businessId: log.businessId,
        source: "rowboat",
        level:
          log.status === "error" ? "error" : log.status === "urgent_alert" ? "warn" : "info",
        event: `rowboat_${log.taskType}_${log.status}`,
        message:
          typeof log.logPayload.message === "string"
            ? log.logPayload.message
            : `${log.taskType} ${log.status}`,
        payload: { log_id: logId, task_type: log.taskType, status: log.status }
      })
    );

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
