/**
 * Transactional emails for auto-reload states a tenant cannot discover on
 * their own.
 *
 * Auto-reload runs unattended, so silence is the default experience. Three
 * states genuinely need a nudge: the rule was switched off after repeated
 * declines, the bank wants the cardholder present, and the monthly budget
 * ceiling was reached. Everything else (a successful top-up, a soft decline
 * that will retry) is visible in the billing page ledger and does not warrant
 * an interruption.
 *
 * Deterministic and input-pure: no DB reads, no Date.now(), no env lookups.
 */

import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

export type AutoReloadAlertKind =
  | "disabled"
  | "disabled_no_card"
  | "paused_authentication"
  | "monthly_limit";

export type AutoReloadAlertInput = {
  kind: AutoReloadAlertKind;
  category: "voice" | "sms" | "chat";
  businessName: string;
  /**
   * Present so the caller cannot build an alert for nobody. Not used in the
   * body: the dispatcher addresses and renders the message.
   */
  recipientEmail: string;
  /** App origin without a trailing slash. */
  siteUrl: string;
  /** Consecutive declines, for the disabled email. */
  attempts?: number;
  locale?: AppLocale;
};

export type AutoReloadAlertEmail = {
  subject: string;
  text: string;
  /**
   * Where the reader has to go to fix this, and what to call the button.
   *
   * No `html` here on purpose. `dispatchUrgentNotification` renders the
   * branded HTML for every alert, including the unsubscribe footer, so a
   * second renderer in this file would be dead code that silently diverged
   * from what actually gets sent.
   */
  ctaLabel: string;
  billingUrl: string;
};

export function buildAutoReloadAlertEmail(input: AutoReloadAlertInput): AutoReloadAlertEmail {
  const locale = input.locale ?? defaultLocale;
  const messages = emailMessagesForLocale(locale);
  const copy = messages.autoReload;
  const normalizedSite = input.siteUrl.replace(/\/$/, "");
  const billingUrl = `${normalizedSite}/dashboard/billing`;

  const familyName =
    input.category === "voice"
      ? copy.familyVoice
      : input.category === "sms"
        ? copy.familySms
        : copy.familyChat;

  let subject: string;
  let textLines: string[];

  if (input.kind === "disabled") {
    subject = fmtEmail(copy.disabledSubject, { business: input.businessName });
    textLines = [
      copy.disabledLine1,
      fmtEmail(copy.disabledLine2, {
        attempts: String(input.attempts ?? 3),
        familyName
      }),
      copy.disabledLine3
    ];
  } else if (input.kind === "disabled_no_card") {
    // Deliberately separate copy: this path disables after a SINGLE failure,
    // so the "declined three times in a row" line would be a lie.
    subject = fmtEmail(copy.noCardSubject, { business: input.businessName });
    textLines = [
      copy.noCardLine1,
      fmtEmail(copy.noCardLine2, { familyName }),
      copy.noCardLine3
    ];
  } else if (input.kind === "paused_authentication") {
    subject = fmtEmail(copy.pausedSubject, { business: input.businessName });
    textLines = [copy.pausedLine1, fmtEmail(copy.pausedLine2, { familyName })];
  } else {
    subject = fmtEmail(copy.limitSubject, { business: input.businessName });
    textLines = [copy.limitLine1, fmtEmail(copy.limitLine2, { familyName })];
  }

  const text = [...textLines, billingUrl, messages.ncSignoff].join("\n\n");

  return { subject, text, ctaLabel: copy.cta, billingUrl };
}
