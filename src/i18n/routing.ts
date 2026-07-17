import { defineRouting } from "next-intl/routing";

export const locales = ["en", "es"] as const;
export type AppLocale = (typeof locales)[number];

export const defaultLocale: AppLocale = "en";

export const LOCALE_COOKIE = "NEXT_LOCALE";

export const routing = defineRouting({
  locales: [...locales],
  defaultLocale,
  /** English keeps canonical URLs (/dashboard); Spanish marketing may use /es/... */
  localePrefix: "as-needed"
});

export function isAppLocale(value: string | null | undefined): value is AppLocale {
  return value === "en" || value === "es";
}
