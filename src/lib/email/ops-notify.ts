/**
 * Direct sender for operator notifications, for callers that don't run
 * through the lifecycle executor (e.g. the change-plan orchestrator's
 * old-box teardown). The executor has its own inline dispatch of the same
 * template so ops emails stay ordered inside lifecycle plans.
 */

import { logger } from "@/lib/logger";
import { sendOwnerEmail } from "@/lib/email/client";
import {
  buildOpsVpsDeletionEmail,
  opsNotificationEmail,
  type OpsVpsDeletionInput
} from "@/lib/email/templates/ops-vps-deletion";

/** Fire-and-forget ops deletion request; never throws. */
export async function sendOpsVpsDeletionEmail(
  input: Omit<OpsVpsDeletionInput, "siteUrl">
): Promise<void> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      logger.warn("ops VPS deletion email skipped: RESEND_API_KEY missing", {
        businessId: input.businessId,
        virtualMachineId: input.virtualMachineId
      });
      return;
    }
    const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const toEmail = opsNotificationEmail();
    const { subject, text, html } = buildOpsVpsDeletionEmail({ ...input, siteUrl });
    await sendOwnerEmail(apiKey, toEmail, subject, { text, html });
    logger.info("ops VPS deletion request emailed", {
      businessId: input.businessId,
      virtualMachineId: input.virtualMachineId,
      hostingerBillingSubscriptionId: input.hostingerBillingSubscriptionId,
      toEmail
    });
  } catch (err) {
    logger.warn("ops VPS deletion email failed", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
