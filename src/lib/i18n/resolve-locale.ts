import type { AppLocale } from "@/i18n/routing";
import { defaultLocale, isAppLocale, LOCALE_COOKIE } from "@/i18n/routing";

/**
 * Resolve the owner UI locale. Never reads Accept-Language — English unless
 * the user explicitly chose Spanish (saved preference or NEXT_LOCALE cookie).
 */
export function resolveUiLocale(opts: {
  savedPreference?: string | null;
  cookieLocale?: string | null;
  /** Ignored by design — present only so callers can pass headers without using them. */
  acceptLanguage?: string | null;
}): AppLocale {
  void opts.acceptLanguage;
  if (isAppLocale(opts.savedPreference)) return opts.savedPreference;
  if (isAppLocale(opts.cookieLocale)) return opts.cookieLocale;
  return defaultLocale;
}

export function localeCookieValue(locale: AppLocale): { name: string; value: string } {
  return { name: LOCALE_COOKIE, value: locale };
}
