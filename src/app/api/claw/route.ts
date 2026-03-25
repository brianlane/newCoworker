import { parseClawLog, evaluateUrgency } from "@/lib/claw/logs";
import { insertCoworkerLog } from "@/lib/db/logs";
import { insertNotification } from "@/lib/db/notifications";
import { getBusiness } from "@/lib/db/businesses";
import { sendOwnerSms, readTwilioConfig } from "@/lib/twilio/client";
import { sendOwnerEmail } from "@/lib/email/client";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { randomUUID, timingSafeEqual } from "crypto";

function verifyClawToken(request: Request): boolean {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  if (expected === "" || token.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export async function POST(request: Request) {
  if (!verifyClawToken(request)) {
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

    // Fire notifications for urgent events
    if (urgency.shouldNotify) {
      const business = await getBusiness(log.businessId);
      const ownerEmail = business?.owner_email ?? process.env.OWNER_ALERT_EMAIL;
      const ownerPhone = process.env.TWILIO_OWNER_PHONE;
      const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/dashboard`;

      await insertNotification({
        id: randomUUID(),
        business_id: log.businessId,
        delivery_channel: "dashboard",
        status: "sent",
        payload: { summary: urgency.summary, logId }
      });

      if (ownerEmail) {
        try {
          await sendOwnerEmail(
            process.env.RESEND_API_KEY ?? "",
            ownerEmail,
            `Urgent: ${urgency.summary}`,
            `Your AI Coworker flagged an urgent event: ${urgency.summary}\n\nView details: ${dashboardUrl}`
          );
          await insertNotification({
            id: randomUUID(),
            business_id: log.businessId,
            delivery_channel: "email",
            status: "sent",
            payload: { summary: urgency.summary, recipient: ownerEmail }
          });
        } catch (err) {
          logger.warn("Urgent email failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (ownerPhone) {
        try {
          const config = readTwilioConfig();
          await sendOwnerSms(config, ownerPhone, `Urgent from New Coworker: ${urgency.summary}`);
          await insertNotification({
            id: randomUUID(),
            business_id: log.businessId,
            delivery_channel: "sms",
            status: "sent",
            payload: { summary: urgency.summary, recipient: ownerPhone }
          });
        } catch (err) {
          logger.warn("Urgent SMS failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    return successResponse({ logId, urgency });
  } catch (err) {
    return handleRouteError(err);
  }
}
