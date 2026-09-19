/**
 * Transactional email: cancel-confirmation.
 *
 * Sent by the lifecycle executor on every cancel action
 * (`cancelWithRefund`, `cancelAtPeriodEnd`, `autoCancelOnPaymentFailure`,
 * `adminForceCancel`, `externalStripeCancel`). Copy branches on the cancel
 * reason so the tenant gets an accurate account of what just happened and
 * what they can do next (undo, reactivate, or just let the wipe clock run
 * out). Keep/lose lines match the in-app cancel confirm sheet.
 *
 * Keep this file deterministic and input-pure: no DB reads, no `Date.now()`,
 * no env lookups. Easy to snapshot-test and reason about.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import type { CancelReason } from "@/lib/db/subscriptions";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailDate, emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";
import {
  CANCEL_KEEP_CATALOG_KEYS,
  CANCEL_LOSS_CATALOG_KEYS,
  cancelConfirmModeForReason,
  cancelConfirmPreview,
  cancelReasonShowsKeepLose
} from "@/lib/billing/cancel-copy";
import {
  formatPlanChangePaidThroughDate,
  parseablePaidThroughIso,
  STARTER_DOWNGRADE_KEEP_CATALOG_KEYS,
  STARTER_DOWNGRADE_KEEP_IDS,
  STARTER_DOWNGRADE_LOSS_CATALOG_KEYS,
  STARTER_DOWNGRADE_LOSS_IDS
} from "@/lib/billing/plan-change-copy";

export type CancelConfirmationInput = {
  reason: CancelReason;
  /** ISO timestamp when the cancel takes effect (today for refund/admin/payment; period_end date for scheduled). */
  effectiveAt: string;
  /** ISO timestamp when data will be wiped, or null for scheduled-period-end (grace starts after the period). */
  graceEndsAt: string | null;
  recipientEmail: string;
  /** App origin without trailing slash (e.g. [REDACTED]). */
  siteUrl: string;
  /**
   * IANA timezone (e.g. "America/Phoenix") the dates are rendered in. Emails
   * have no "viewer", so without this the server's zone (UTC) leaks into copy
   * like "ends on June 1". Falls back to the runtime default when omitted.
   */
  timeZone?: string;
  /** Recipient's UI locale; defaults to English. */
  locale?: AppLocale;
  /** Current membership tier, so the loss list matches what they actually had. */
  currentTier?: "starter" | "standard" | "enterprise" | null;
  /** Hostinger `expires_at` when known, for the prepaid-cliff honesty line. */
  hostingerExpiresAt?: string | null;
  /**
   * Clock for prepaid-through math. Injected so this builder stays free of
   * `Date.now()`. Executor passes the plan's `now`.
   */
  nowMs?: number;
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
  // Signoff rides only the plain-text body, the HTML shell renders the full
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

function keepLoseSummary(
  c: ReturnType<typeof emailMessagesForLocale>["cancelConfirmation"],
  input: CancelConfirmationInput,
  locale: AppLocale
): string | null {
  if (!cancelReasonShowsKeepLose(input.reason)) return null;
  const preview = cancelConfirmPreview({
    mode: cancelConfirmModeForReason(input.reason),
    currentTier: input.currentTier ?? "starter",
    periodEnd: input.effectiveAt,
    boxExpiresAt: input.hostingerExpiresAt,
    hasLiveBox: input.hostingerExpiresAt != null && input.hostingerExpiresAt !== "",
    nowMs: input.nowMs ?? 0
  });
  const lines = [
    c.keepLead,
    ...preview.keepIds.map((id) => `• ${c[CANCEL_KEEP_CATALOG_KEYS[id]]}`),
    c.lossLead,
    ...preview.lossIds.map((id) => `• ${c[CANCEL_LOSS_CATALOG_KEYS[id]]}`)
  ];
  const iso = parseablePaidThroughIso(input.hostingerExpiresAt, input.nowMs ?? 0);
  const date = iso ? formatPlanChangePaidThroughDate(iso, locale) : null;
  if (preview.hardwareKey === "cliffDated" || preview.hardwareKey === "cliffGeneric") {
    lines.push(date ? fmtEmail(c.hostingerCliffDated, { date }) : c.hostingerCliffGeneric);
  } else if (preview.hardwareKey === "periodEndDated" && date) {
    lines.push(fmtEmail(c.hostingerPeriodEndDated, { date }));
  }
  return lines.join("\n");
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
  const keepLose = keepLoseSummary(c, input, locale);

  if (input.reason === "user_period_end") {
    return envelope(
      c.periodEndSubject,
      [
        c.periodEnd1,
        fmtEmail(c.periodEnd2, { date: effective }),
        c.periodEnd3,
        c.periodEnd4,
        ...(keepLose ? [keepLose] : [])
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
        c.payment3,
        ...(keepLose ? [keepLose] : [])
      ],
      copy.ncSignoff,
      input.siteUrl,
      input.recipientEmail,
      billingCta
    );
  }

  if (input.reason === "upgrade_switch") {
    const starterCuts = [
      c.upgradeStandardPerksStopNow,
      c.upgradeStarterKeepLead,
      ...STARTER_DOWNGRADE_KEEP_IDS.map(
        (id) => `• ${c[STARTER_DOWNGRADE_KEEP_CATALOG_KEYS[id]]}`
      ),
      c.upgradeStarterCutsLead,
      ...STARTER_DOWNGRADE_LOSS_IDS.map(
        (id) => `• ${c[STARTER_DOWNGRADE_LOSS_CATALOG_KEYS[id]]}`
      ),
      c.upgradeStarterWebhookKeep,
      c.upgradeStarterCutsKeep
    ].join("\n");
    return envelope(
      c.upgradeSubject,
      [c.upgrade1, c.upgrade2, c.upgrade3, starterCuts],
      copy.ncSignoff,
      input.siteUrl,
      input.recipientEmail,
      { label: copy.openDashboardCta, href: dashboardUrl }
    );
  }

  if (input.reason === "admin_force") {
    return envelope(
      c.adminSubject,
      [c.adminLeadIn, c.admin2, c.admin3],
      copy.ncSignoff,
      input.siteUrl,
      input.recipientEmail,
      undefined
    );
  }

  if (input.reason === "stripe_external") {
    return envelope(
      c.defaultSubject,
      [
        c.stripeExternalLeadIn,
        fmtEmail(c.default2, { date: graceEnds ?? c.thirtyDays }),
        ...(keepLose ? [keepLose] : []),
        c.default3
      ],
      copy.ncSignoff,
      input.siteUrl,
      input.recipientEmail,
      billingCta
    );
  }

  return envelope(
    c.defaultSubject,
    [
      c.userLeadIn,
      fmtEmail(c.default2, { date: graceEnds ?? c.thirtyDays }),
      ...(keepLose ? [keepLose] : []),
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
