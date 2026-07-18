import type { AppLocale } from "@/i18n/routing";

const INTL_LOCALE: Record<AppLocale, string> = {
  en: "en-US",
  es: "es-US"
};

export function intlLocaleForApp(locale: AppLocale): string {
  return INTL_LOCALE[locale];
}

export function formatPricePerMonthLocalized(
  cents: number,
  locale: AppLocale
): string {
  const intl = intlLocaleForApp(locale);
  const dollars = cents / 100;
  if (Number.isInteger(dollars)) {
    return `$${dollars.toLocaleString(intl)}`;
  }
  const [integer, decimal] = dollars.toFixed(2).split(".");
  return `$${parseInt(integer, 10).toLocaleString(intl)}.${decimal}`;
}
