"use client";

import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";

export type NavLink = { href: string; labelKey: string };

export const MARKETING_NAV_LINKS: NavLink[] = [
  { href: "/features", labelKey: "features" },
  { href: "/pricing", labelKey: "pricing" },
  { href: "/integrations", labelKey: "integrations" },
  { href: "/industries", labelKey: "industries" },
  { href: "/faq", labelKey: "faq" },
  { href: "/about", labelKey: "about" }
];

export function MarketingNav() {
  const t = useTranslations("marketing.nav");
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-parchment/10 bg-deep-ink/85 backdrop-blur-md">
      <nav className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-6 py-4">
        <Link href="/" className="flex items-center gap-3" onClick={() => setOpen(false)}>
          <Image src="/logo.png" alt={t("brand")} width={34} height={34} className="rounded-full" />
          <span className="text-lg font-bold tracking-tight text-parchment">{t("brand")}</span>
        </Link>

        <div className="hidden items-center gap-7 md:flex">
          {MARKETING_NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm font-medium text-parchment/65 transition-colors hover:text-parchment"
            >
              {t(l.labelKey)}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-4 md:flex">
          <LanguageSwitcher />
          <Link href="/login" className="text-sm text-parchment/60 transition-colors hover:text-parchment">
            {t("signIn")}
          </Link>
          <Link
            href="/onboard"
            className="rounded-lg bg-claw-green px-4 py-2 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90"
          >
            {t("getStarted")}
          </Link>
        </div>

        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg border border-parchment/15 p-2 text-parchment md:hidden"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </nav>

      {open && (
        <div className="border-t border-parchment/10 px-6 pb-6 pt-3 md:hidden">
          <div className="mb-3">
            <LanguageSwitcher />
          </div>
          <div className="flex flex-col gap-1">
            {MARKETING_NAV_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-parchment/75 transition-colors hover:bg-parchment/5 hover:text-parchment"
              >
                {t(l.labelKey)}
              </Link>
            ))}
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-2.5 text-sm font-medium text-parchment/75 transition-colors hover:bg-parchment/5 hover:text-parchment"
            >
              {t("signIn")}
            </Link>
            <Link
              href="/onboard"
              onClick={() => setOpen(false)}
              className="mt-2 rounded-lg bg-claw-green px-4 py-2.5 text-center text-sm font-semibold text-deep-ink"
            >
              {t("getStarted")}
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
