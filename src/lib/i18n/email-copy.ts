import type { AppLocale } from "@/i18n/routing";
import en from "../../../messages/en.json";
import es from "../../../messages/es.json";

type EmailMessages = typeof en.emails;

export function emailMessagesForLocale(locale: AppLocale): EmailMessages {
  return locale === "es" ? es.emails : en.emails;
}
