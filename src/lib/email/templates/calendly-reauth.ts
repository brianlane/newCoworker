/**
 * Product email when a Calendly connection is permanently rejected.
 *
 * The owner has to paste a new Personal Access Token (Calendly has no
 * first-party OAuth consent in this product). The copy names the account,
 * says calendar follow-ups and booking checks are paused, and deep-links
 * into Reconnect on that same connection row. It never says "token rejected".
 *
 * Deterministic and input-pure (no DB, no Date.now(), no env) so the copy is
 * testable without a stack, matching the other templates in this directory.
 */

import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";
import { calendlyReconnectPath } from "@/lib/calendly/reauth-copy";

export type CalendlyReauthEmailInput = {
  /** Display name or email of the rejected Calendly account. */
  accountLabel: string;
  /** The calendly_connections row to reconnect. */
  connectionId: string;
  /**
   * Already-formatted last successful check (e.g. "Sep 16, 2026, 5:01 AM"),
   * or null when we have never stamped one. The template omits the line
   * rather than inventing a time.
   */
  lastHealthyLabel?: string | null;
  locale?: AppLocale;
};

export type CalendlyReauthEmailCopy = {
  subject: string;
  heading: string;
  body: string;
  smsBody: string;
  ctaLabel: string;
  ctaPath: string;
  summaryLine: string;
};

export function buildCalendlyReauthEmail(
  input: CalendlyReauthEmailInput
): CalendlyReauthEmailCopy {
  const locale = input.locale ?? defaultLocale;
  const copy = emailMessagesForLocale(locale).calendlyReauth;
  const vars = { account: input.accountLabel };
  const lastHealthy = input.lastHealthyLabel?.trim() || null;

  return {
    subject: copy.subject,
    heading: copy.heading,
    body: [
      fmtEmail(copy.intro, vars),
      lastHealthy ? fmtEmail(copy.lastCheck, { when: lastHealthy }) : null,
      copy.paused,
      copy.action
    ]
      .filter((b): b is string => typeof b === "string" && b.length > 0)
      .join("\n\n"),
    smsBody: fmtEmail(copy.sms, vars),
    ctaLabel: copy.cta,
    ctaPath: calendlyReconnectPath(input.connectionId),
    summaryLine: fmtEmail(copy.summary, vars)
  };
}
