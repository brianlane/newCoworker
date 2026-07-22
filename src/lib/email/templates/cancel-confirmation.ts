/**
 * Transactional email: cancel-confirmation.
 *
 * Sent by the lifecycle executor on every cancel action
 * (`cancelWithRefund`, `cancelAtPeriodEnd`, `autoCancelOnPaymentFailure`,
 * `adminForceCancel`). Copy branches on the cancel reason so the tenant
 * gets an accurate account of what just happened and what they can do
 * next (undo, reactivate, or just let the wipe clock run out).
 *
 * Keep this file deterministic and input-pure: no DB reads, no `Date.now()`,
 * no env lookups. Easy to snapshot-test and reason about.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import type { CancelReason } from "@/lib/db/subscriptions";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailDate, emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

export type CancelConfirmationInput = {
  reason: CancelReason;
  /** ISO timestamp when the cancel takes effect (today for refund/admin/payment; period_end date for scheduled). */
  effectiveAt: string;
  /** ISO timestamp when data will be wiped, or null for scheduled-period-end (grace starts after the period). */
  graceEndsAt: string | null;
  recipientEmail: string;
  /** App origin without trailing slash (e.g. https://www.newcoworker.com). */
  siteUrl: string;
  /**
   * IANA timezone (e.g. "America/Phoenix") the dates are rendered in. Emails
   * have no "viewer", so without this the server's zone (UTC) leaks into copy
   * like "ends on June 1". Falls back to the runtime default when omitted.
   */
  timeZone?: string;
  /** Recipient's UI locale; defaults to English. */
  locale?: AppLocale;
};

export type CancelConfirmationEmail = {
  subject: string;
  text: string;
  html: string;
};

function envelope(
  subject: string,
  textLines: string[],
  signoff: string,
  siteUrl: string,
  recipientEmail: string,
  cta: { label: string; href: string } | undefined
): CancelConfirmationEmail {
  const normalizedSite = siteUrl.replace(/\/$/, "");
  // Signoff rides only the plain-text body — the HTML shell renders the full
  // platform signature block, so repeating it there would double the contact info.
  const text = [...textLines, signoff].join("\n\n");
  const html = buildBrandedEmailHtml({
    siteUrl: normalizedSite,
    documentTitle: subject,
    heading: subject,
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    ...(cta ? { cta } : {}),
    includeFallbackLink: cta !== undefined,
    recipientEmail
  });
  return { subject, text, html };
}

export function buildCancelConfirmationEmail(
  input: CancelConfirmationInput
): CancelConfirmationEmail {
  const locale = input.locale ?? defaultLocale;
  const copy = emailMessagesForLocale(locale);
  const c = copy.cancelConfirmation;
  const effective = fmtDate(input.effectiveAt, locale, input.timeZone);
  const graceEnds = input.graceEndsAt ? fmtDate(input.graceEndsAt, locale, input.timeZone) : null;
  const normalizedSite = input.siteUrl.replace(/\/$/, "");
  const billingUrl = `${normalizedSite}/dashboard/billing`;
  const dashboardUrl = `${normalizedSite}/dashboard`;
  const billingCta = { label: copy.openBilling, href: billingUrl };

  if (input.reason === "user_period_end") {
    return envelope(
      c.periodEndSubject,
      [
        c.periodEnd1,
        fmtEmail(c.periodEnd2, { date: effective }),
        c.periodEnd3,
        c.periodEnd4
      ],
      copy.ncSignoff,
      input.siteUrl,
      input.recipientEmail,
      billingCta
    );
  }

  if (input.reason === "payment_failed") {
    return envelope(
      c.paymentSubject,
      [
        c.payment1,
        fmtEmail(c.payment2, { date: graceEnds ?? c.thirtyDays }),
        c.payment3
      ],
      copy.ncSignoff,
      input.siteUrl,
      input.recipientEmail,
      billingCta
    );
  }

  if (input.reason === "upgrade_switch") {
    return envelope(
      c.upgradeSubject,
      [c.upgrade1, c.upgrade2, c.upgrade3],
      copy.ncSignoff,
      input.siteUrl,
      input.recipientEmail,
      { label: copy.openDashboardCta, href: dashboardUrl }
    );
  }

  const leadIn = input.reason === "admin_force" ? c.adminLeadIn : c.userLeadIn;
  if (input.reason === "admin_force") {
    return envelope(
      c.adminSubject,
      [leadIn, c.admin2, c.admin3],
      copy.ncSignoff,
      input.siteUrl,
      input.recipientEmail,
      undefined
    );
  }

  return envelope(
    c.defaultSubject,
    [
      leadIn,
      fmtEmail(c.default2, { date: graceEnds ?? c.thirtyDays }),
      c.default3
    ],
    copy.ncSignoff,
    input.siteUrl,
    input.recipientEmail,
    billingCta
  );
}

function fmtDate(iso: string, locale: AppLocale, timeZone?: string): string {
  try {
    return emailDate(new Date(iso), locale, timeZone);
  } catch {
    return iso;
  }
}
