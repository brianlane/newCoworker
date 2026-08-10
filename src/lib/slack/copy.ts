/**
 * Fixed Slack-side strings the bot posts into the tenant's workspace.
 * Locale-parameterized with an English default, following the
 * src/lib/i18n/email-copy.ts convention: tenant-facing copy never reads
 * Accept-Language, only the owner's explicit UI locale choice.
 */
import type { AppLocale } from "@/i18n/routing";

const ALERT_CHANNEL_HELLO: Record<AppLocale, string> = {
  en: "👋 I'm your New Coworker. Alerts for your business will arrive in this channel.",
  es: "👋 Soy tu New Coworker. Los avisos de tu negocio llegarán a este canal."
};

/** Posted once when the owner picks (or changes) the alert channel. */
export function slackAlertChannelHelloMessage(locale: AppLocale = "en"): string {
  return ALERT_CHANNEL_HELLO[locale] ?? ALERT_CHANNEL_HELLO.en;
}
