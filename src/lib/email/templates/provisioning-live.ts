/**
 * Transactional email: coworker provisioning complete (“Your AI Coworker is live!”).
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale } from "@/lib/i18n/email-copy";

export type ProvisioningLiveEmailInput = {
  dashboardUrl: string;
  siteUrl: string;
  recipientEmail: string;
  locale?: AppLocale;
};

export type ProvisioningLiveEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildProvisioningLiveEmail(input: ProvisioningLiveEmailInput): ProvisioningLiveEmail {
  const locale = input.locale ?? defaultLocale;
  const copy = emailMessagesForLocale(locale);
  const subject = copy.provisioningLive.subject;
  const body = copy.provisioningLive.body;
  const text = [
    body,
    `${copy.common.visitDashboard} ${input.dashboardUrl}`,
    copy.common.teamSignoff
  ].join("\n\n");

  const html = buildBrandedEmailHtml({
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: subject,
    bodyBlocks: [{ kind: "text", text: body }],
    cta: { label: copy.common.goToDashboard, href: input.dashboardUrl },
    recipientEmail: input.recipientEmail
  });

  return { subject, text, html };
}
