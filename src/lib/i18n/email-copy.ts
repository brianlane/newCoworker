import type { AppLocale } from "@/i18n/routing";
import en from "../../../messages/en.json";
import es from "../../../messages/es.json";

type EmailMessages = typeof en.emails;

export function emailMessagesForLocale(locale: AppLocale): EmailMessages {
  return locale === "es" ? es.emails : en.emails;
}

/**
 * Tiny `{var}` interpolator for the email catalogs. Emails are plain
 * strings built outside the React tree, so next-intl's ICU pipeline isn't
 * available — this mirrors the `.replace("{summary}", …)` pattern the
 * urgent-alert dispatcher already uses, generalized to any variable set.
 */
export function fmtEmail(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? vars[name] : match
  );
}

/** Locale-tagged long date for email copy (e.g. "July 18, 2026"). */
export function emailDate(date: Date, locale: AppLocale, timeZone?: string): string {
  return date.toLocaleDateString(locale === "es" ? "es-US" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    ...(timeZone ? { timeZone } : {})
  });
}
