/**
 * Product email when a stored OAuth (or equivalent) grant is permanently
 * rejected. Calendly keeps its own template; this one is shared by Zoom,
 * Google, Microsoft 365, Acuity, CalDAV, Vagaro, Facebook, Slack, and
 * WhatsApp.
 *
 * The copy names the provider and the account, says dependent work is
 * paused, and deep-links into Reconnect on that same connection row. It
 * never says "token rejected".
 *
 * Deterministic and input-pure (no DB, no Date.now(), no env) so the copy is
 * testable without a stack, matching the other templates in this directory.
 */

import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";
import {
  connectionReconnectPath,
  type ConnectionReauthProviderLabel
} from "@/lib/connections/reauth-copy";

export type ConnectionReauthEmailInput = {
  provider: ConnectionReauthProviderLabel;
  accountLabel: string;
  connectionId: string;
  slug: string;
  pausedWork: string;
  lastHealthyLabel?: string | null;
  locale?: AppLocale;
};

export type ConnectionReauthEmailCopy = {
  subject: string;
  heading: string;
  body: string;
  smsBody: string;
  ctaLabel: string;
  ctaPath: string;
  summaryLine: string;
};

export function buildConnectionReauthEmail(
  input: ConnectionReauthEmailInput
): ConnectionReauthEmailCopy {
  const locale = input.locale ?? defaultLocale;
  const copy = emailMessagesForLocale(locale).connectionReauth;
  const vars = {
    account: input.accountLabel,
    provider: input.provider,
    pausedWork: input.pausedWork
  };
  const lastHealthy = input.lastHealthyLabel?.trim() || null;

  return {
    subject: fmtEmail(copy.subject, vars),
    heading: fmtEmail(copy.heading, vars),
    body: [
      fmtEmail(copy.intro, vars),
      lastHealthy ? fmtEmail(copy.lastCheck, { when: lastHealthy }) : null,
      fmtEmail(copy.paused, vars),
      fmtEmail(copy.action, vars)
    ]
      .filter((b): b is string => typeof b === "string" && b.length > 0)
      .join("\n\n"),
    smsBody: fmtEmail(copy.sms, vars),
    ctaLabel: fmtEmail(copy.cta, vars),
    ctaPath: connectionReconnectPath(input.slug, input.connectionId),
    summaryLine: fmtEmail(copy.summary, vars)
  };
}
