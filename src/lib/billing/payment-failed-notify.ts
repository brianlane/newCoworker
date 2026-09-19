/**
 * Owner + ops mail for a membership invoice payment failure.
 *
 * Independent of auto-cancel: Scar Fairy's cancel confirmation never went
 * out because the webhook race skipped the lifecycle emails. This notify
 * runs on `invoice.payment_failed` itself.
 */

import { logger } from "@/lib/logger";
import { sendOwnerEmail } from "@/lib/email/client";
import { sendOpsPaymentFailedEmail } from "@/lib/email/ops-notify";
import { buildPaymentDeclinedEmail } from "@/lib/email/templates/payment-declined";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import { getBusiness, type BusinessRow } from "@/lib/db/businesses";
import { isCanceledInGrace, type SubscriptionRow } from "@/lib/db/subscriptions";
import {
  formatPaymentFailureDetail,
  invoicePaymentFailureDetails,
  type InvoicePaymentFailureDetails
} from "@/lib/billing/payment-failed";

export type NotifyInvoicePaymentFailedInput = {
  existing: SubscriptionRow;
  invoice: Parameters<typeof invoicePaymentFailureDetails>[0];
  stripeSubscriptionId: string | null;
  willAutoCancel: boolean;
};

export type NotifyInvoicePaymentFailedDeps = {
  getBusinessRow?: typeof getBusiness;
  sendOwner?: typeof sendOwnerEmail;
  sendOps?: typeof sendOpsPaymentFailedEmail;
  resolveLocale?: typeof resolveOwnerUiLocaleForEmail;
  resendApiKey?: string | undefined;
  appUrl?: string;
};

export async function notifyInvoicePaymentFailed(
  input: NotifyInvoicePaymentFailedInput,
  deps: NotifyInvoicePaymentFailedDeps = {}
): Promise<void> {
  /* c8 ignore start -- production defaults; unit tests inject every dep */
  const readBusiness = deps.getBusinessRow ?? getBusiness;
  const sendOwner = deps.sendOwner ?? sendOwnerEmail;
  const sendOps = deps.sendOps ?? sendOpsPaymentFailedEmail;
  const resolveLocale = deps.resolveLocale ?? resolveOwnerUiLocaleForEmail;
  const apiKey = deps.resendApiKey ?? process.env.RESEND_API_KEY;
  const siteUrl = (deps.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000").replace(
    /\/$/,
    ""
  );
  /* c8 ignore stop */

  const details: InvoicePaymentFailureDetails = invoicePaymentFailureDetails(input.invoice);
  const failureDetail = formatPaymentFailureDetail(details);
  const business: BusinessRow | null = await readBusiness(input.existing.business_id);
  const ownerEmail = business?.owner_email ?? "";
  const inGrace = isCanceledInGrace(input.existing);
  const shouldEmailOwner =
    input.existing.status === "active" || inGrace || input.willAutoCancel;

  if (apiKey && ownerEmail && shouldEmailOwner) {
    try {
      const { subject, text, html } = buildPaymentDeclinedEmail({
        recipientEmail: ownerEmail,
        siteUrl,
        failureDetail,
        graceEndsAt: input.existing.grace_ends_at,
        locale: await resolveLocale(ownerEmail),
        ...(business?.timezone ? { timeZone: business.timezone } : {})
      });
      await sendOwner(apiKey, ownerEmail, subject, { text, html });
    } catch (err) {
      logger.warn("owner payment-declined email failed", {
        businessId: input.existing.business_id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  } else if (!apiKey) {
    logger.warn("owner payment-declined skipped: RESEND_API_KEY missing", {
      businessId: input.existing.business_id
    });
  }

  await sendOps({
    businessId: input.existing.business_id,
    businessName: business?.name ?? "",
    ownerName: business?.owner_name ?? null,
    ownerEmail: ownerEmail || "(none on file)",
    tier: input.existing.tier,
    invoiceId: details.invoiceId,
    stripeSubscriptionId: input.stripeSubscriptionId,
    failureDetail,
    dbStatus: input.existing.status,
    willAutoCancel: input.willAutoCancel
  });
}
