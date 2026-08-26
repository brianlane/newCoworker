"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { AppLocale } from "@/i18n/routing";
import { LOCALE_COOKIE } from "@/i18n/routing";
import { esAlternates, isMirroredMarketingPath, stripSpanishPrefix } from "@/lib/i18n/es-routes";

type Props = {
  /** When true, POST /api/account/locale after change (signed-in dashboard). */
  persist?: boolean;
  className?: string;
};

export function LanguageSwitcher({ persist = false, className = "" }: Props) {
  const t = useTranslations("common");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function setLocale(next: AppLocale) {
    if (next === locale) return;
    setError(null);

    if (persist) {
      const res = await fetch("/api/account/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next })
      });
      if (!res.ok) {
        setError(t("languageSaveFailed"));
        return;
      }
    } else {
      document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
      // Signed-in visitors switching from a marketing page: also persist
      // best-effort, because the saved account preference wins over the
      // cookie at resolve time and would otherwise revert the switch on the
      // next load. Signed-out visitors just get a 401 here, ignored.
      // keepalive survives the navigation below.
      void fetch("/api/account/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
        keepalive: true
      }).catch(() => undefined);
      // Non-marketing paths have no /es mirror, so they fall through to a
      // plain refresh instead of gaining a prefix that would 404.
      if (next === "es" && isMirroredMarketingPath(window.location.pathname)) {
        const prefixed = esAlternates(stripSpanishPrefix(window.location.pathname)).languages.es;
        window.location.href = prefixed + window.location.search;
        return;
      }
      if (next === "en") {
        const bare = stripSpanishPrefix(window.location.pathname);
        if (bare !== window.location.pathname) {
          window.location.href = bare + window.location.search;
          return;
        }
      }
    }

    startTransition(() => router.refresh());
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span className="sr-only">{t("language")}</span>
      <select
        aria-label={t("language")}
        value={locale}
        disabled={pending}
        onChange={(e) => void setLocale(e.target.value as AppLocale)}
        className="rounded-md border border-parchment/15 bg-deep-ink/50 px-2 py-1 text-xs text-parchment/80"
      >
        <option value="en">{t("english")}</option>
        <option value="es">{t("spanish")}</option>
      </select>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
