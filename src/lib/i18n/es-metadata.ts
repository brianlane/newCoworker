import { headers } from "next/headers";
import { esAlternates, isSpanishMarketingPath } from "@/lib/i18n/es-routes";

/**
 * Canonical + hreflang for a marketing page, keyed off the URL the visitor
 * actually requested (x-pathname), not the NEXT_LOCALE cookie.
 *
 * The cookie is the UI language. A Spanish cookie on /pricing must not tell
 * Google that /pricing is a duplicate of /es/pricing. The /es rewrite in
 * proxy.ts forwards the original path as x-pathname so crawlers, who send
 * no cookie, still get a self-canonical Spanish URL.
 */
export async function esAlternatesForRequest(path: string) {
  const headerStore = await headers();
  const requested = (headerStore.get("x-pathname") ?? "").split("?")[0];
  const locale = isSpanishMarketingPath(requested) ? "es" : "en";
  return esAlternates(path, locale);
}
