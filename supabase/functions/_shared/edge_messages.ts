import edgeEn from "../../../messages/edge-en.json" with { type: "json" };
import edgeEs from "../../../messages/edge-es.json" with { type: "json" };

export type EdgeMessageKey = keyof typeof edgeEn;
export type EdgeLocale = "en" | "es";

export function edgeMessage(key: EdgeMessageKey, locale: EdgeLocale = "en"): string {
  // Bundles have identical keys (enforced by tests/i18n-messages.test.ts).
  const bundle: Record<EdgeMessageKey, string> = locale === "es" ? edgeEs : edgeEn;
  return bundle[key];
}

export function telnyxTtsLanguage(locale: EdgeLocale): string {
  return locale === "es" ? "es-US" : "en-US";
}
