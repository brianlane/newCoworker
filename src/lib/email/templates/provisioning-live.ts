/**
 * Transactional email: coworker provisioning complete (“Your AI Coworker is live!”).
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";

export type ProvisioningLiveEmailInput = {
  dashboardUrl: string;
  siteUrl: string;
  recipientEmail: string;
};

export type ProvisioningLiveEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildProvisioningLiveEmail(input: ProvisioningLiveEmailInput): ProvisioningLiveEmail {
  const subject = "Your AI Coworker is live!";
  const text = [
    "Your New Coworker is set up and ready.",
    `Visit your dashboard: ${input.dashboardUrl}`,
    "— The New Coworker Team"
  ].join("\n\n");

  const html = buildBrandedEmailHtml({
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: subject,
    bodyBlocks: [{ kind: "text", text: "Your New Coworker is set up and ready." }],
    cta: { label: "Go to dashboard", href: input.dashboardUrl },
    recipientEmail: input.recipientEmail
  });

  return { subject, text, html };
}
