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
import {
  buildOpsPlanChangeEmail,
  type OpsPlanChangeInput
} from "@/lib/email/templates/ops-plan-change";

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

/**
 * Fire-and-forget "hardware escalation started" ops notification; never
 * throws. Sent by the change-plan orchestrator the moment a paid tier
 * change begins its VPS migration, so the operator sees the escalation
 * when it STARTS (the deletion-request email only marks the end).
 */
export async function sendOpsPlanChangeEmail(
  input: Omit<OpsPlanChangeInput, "siteUrl">
): Promise<void> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      logger.warn("ops plan-change email skipped: RESEND_API_KEY missing", {
        businessId: input.businessId
      });
      return;
    }
    const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const toEmail = opsNotificationEmail();
    const { subject, text, html } = buildOpsPlanChangeEmail({ ...input, siteUrl });
    await sendOwnerEmail(apiKey, toEmail, subject, { text, html });
    logger.info("ops plan-change (hardware escalation) start emailed", {
      businessId: input.businessId,
      fromTier: input.fromTier,
      toTier: input.toTier,
      toEmail
    });
  } catch (err) {
    logger.warn("ops plan-change email failed", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
