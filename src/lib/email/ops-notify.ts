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
import {
  buildOpsDidReleaseFailedEmail,
  type OpsDidReleaseFailedInput
} from "@/lib/email/templates/ops-did-release-failed";
import {
  buildOpsHardwareMigrationEmail,
  type OpsHardwareMigrationInput
} from "@/lib/email/templates/ops-hardware-migration";
import {
  buildOpsTermAlignmentEmail,
  type OpsTermAlignmentInput
} from "@/lib/email/templates/ops-term-alignment";
import {
  buildOpsBillingPostureEmail,
  type OpsBillingPostureInput
} from "@/lib/email/templates/ops-billing-posture";
import {
  buildOpsMarginAlertEmail,
  type OpsMarginAlertInput
} from "@/lib/email/templates/ops-margin-alert";
import {
  buildOpsNewSignupEmail,
  type OpsNewSignupInput
} from "@/lib/email/templates/ops-new-signup";

/**
 * Prefix ops subjects for ENTERPRISE tenants so SLA-bound incidents jump
 * the operator's inbox queue. Best-effort: a lookup hiccup returns the
 * subject untagged rather than delaying or dropping the alert.
 */
export async function tagOpsSubjectForTier(
  subject: string,
  businessId: string
): Promise<string> {
  try {
    const { getBusiness } = await import("@/lib/db/businesses");
    const business = await getBusiness(businessId);
    return business?.tier === "enterprise" ? `[ENTERPRISE] ${subject}` : subject;
  } catch {
    return subject;
  }
}

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
    await sendOwnerEmail(apiKey, toEmail, await tagOpsSubjectForTier(subject, input.businessId), { text, html });
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
    await sendOwnerEmail(apiKey, toEmail, await tagOpsSubjectForTier(subject, input.businessId), { text, html });
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

/**
 * Fire-and-forget "contract-period switch finished" ops notification; never
 * throws. Reports whether the box was migrated onto a term-priced Hostinger
 * purchase, needed no change, or needs a manual hPanel look.
 */
export async function sendOpsTermAlignmentEmail(
  input: Omit<OpsTermAlignmentInput, "siteUrl">
): Promise<void> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      logger.warn("ops term-alignment email skipped: RESEND_API_KEY missing", {
        businessId: input.businessId,
        outcome: input.outcome
      });
      return;
    }
    const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const toEmail = opsNotificationEmail();
    const { subject, text, html } = buildOpsTermAlignmentEmail({ ...input, siteUrl });
    await sendOwnerEmail(apiKey, toEmail, await tagOpsSubjectForTier(subject, input.businessId), { text, html });
    logger.info("ops term-alignment email sent", {
      businessId: input.businessId,
      outcome: input.outcome,
      newBillingPeriod: input.newBillingPeriod,
      toEmail
    });
  } catch (err) {
    logger.warn("ops term-alignment email failed", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Fire-and-forget fleet billing-posture findings email; never throws. Sent
 * by the daily posture cron when any VM's Hostinger auto-renew state
 * contradicts its tenant/pool assignment. Not tier-tagged: findings span
 * multiple businesses.
 */
export async function sendOpsBillingPostureEmail(
  input: Omit<OpsBillingPostureInput, "siteUrl">
): Promise<void> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      logger.warn("ops billing-posture email skipped: RESEND_API_KEY missing", {
        findings: input.findings.length
      });
      return;
    }
    const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const toEmail = opsNotificationEmail();
    const { subject, text, html } = buildOpsBillingPostureEmail({ ...input, siteUrl });
    await sendOwnerEmail(apiKey, toEmail, subject, { text, html });
    logger.info("ops billing-posture email sent", {
      findings: input.findings.length,
      toEmail
    });
  } catch (err) {
    logger.warn("ops billing-posture email failed", {
      findings: input.findings.length,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/** Fire-and-forget margin-alert digest (daily cost-sync watchdog); never throws. */
export async function sendOpsMarginAlertEmail(
  input: Omit<OpsMarginAlertInput, "siteUrl">
): Promise<void> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      logger.warn("ops margin-alert email skipped: RESEND_API_KEY missing", {
        breaches: input.breaches.length
      });
      return;
    }
    const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const toEmail = opsNotificationEmail();
    const { subject, text, html } = buildOpsMarginAlertEmail({ ...input, siteUrl });
    await sendOwnerEmail(apiKey, toEmail, subject, { text, html });
    logger.info("ops margin-alert email sent", {
      breaches: input.breaches.length,
      toEmail
    });
  } catch (err) {
    logger.warn("ops margin-alert email failed", {
      breaches: input.breaches.length,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Fire-and-forget admin-initiated hardware-migration progress email
 * (started / completed / failed); never throws. The migrate-size endpoint
 * answers 202 and runs unattended, so these are the operator's only
 * progress signal.
 */
export async function sendOpsHardwareMigrationEmail(
  input: Omit<OpsHardwareMigrationInput, "siteUrl">
): Promise<void> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      logger.warn("ops hardware-migration email skipped: RESEND_API_KEY missing", {
        businessId: input.businessId,
        phase: input.phase
      });
      return;
    }
    const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const toEmail = opsNotificationEmail();
    const { subject, text, html } = buildOpsHardwareMigrationEmail({ ...input, siteUrl });
    await sendOwnerEmail(apiKey, toEmail, await tagOpsSubjectForTier(subject, input.businessId), { text, html });
    logger.info("ops hardware-migration email sent", {
      businessId: input.businessId,
      phase: input.phase,
      fromSize: input.fromSize,
      toSize: input.toSize,
      toEmail
    });
  } catch (err) {
    logger.warn("ops hardware-migration email failed", {
      businessId: input.businessId,
      phase: input.phase,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/** Fire-and-forget new-signup-live ops alert; never throws. */
export async function sendOpsNewSignupEmail(
  input: Omit<OpsNewSignupInput, "siteUrl">
): Promise<void> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      logger.warn("ops new-signup email skipped: RESEND_API_KEY missing", {
        businessId: input.businessId
      });
      return;
    }
    const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const toEmail = opsNotificationEmail();
    const { subject, text, html } = buildOpsNewSignupEmail({ ...input, siteUrl });
    await sendOwnerEmail(apiKey, toEmail, await tagOpsSubjectForTier(subject, input.businessId), {
      text,
      html
    });
    logger.info("ops new-signup email sent", {
      businessId: input.businessId,
      toEmail
    });
  } catch (err) {
    logger.warn("ops new-signup email failed", {
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Fire-and-forget "DID release failed" ops alert; never throws. Sent by the
 * lifecycle executor when a terminal teardown can't release the tenant's
 * Telnyx number — the wipe stamp removes the business from every retry
 * sweep, so without this alert the number would silently rent forever.
 */
export async function sendOpsDidReleaseFailedEmail(
  input: Omit<OpsDidReleaseFailedInput, "siteUrl">
): Promise<void> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      logger.warn("ops DID-release-failed email skipped: RESEND_API_KEY missing", {
        businessId: input.businessId,
        e164: input.e164
      });
      return;
    }
    const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const toEmail = opsNotificationEmail();
    const { subject, text, html } = buildOpsDidReleaseFailedEmail({ ...input, siteUrl });
    await sendOwnerEmail(apiKey, toEmail, await tagOpsSubjectForTier(subject, input.businessId), { text, html });
    logger.info("ops DID-release-failed alert emailed", {
      businessId: input.businessId,
      e164: input.e164,
      toEmail
    });
  } catch (err) {
    logger.warn("ops DID-release-failed email failed", {
      businessId: input.businessId,
      e164: input.e164,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
