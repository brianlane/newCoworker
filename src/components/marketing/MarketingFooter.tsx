"use client";

import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { SiteChatWidget } from "@/components/marketing/SiteChatWidget";

type FooterLink = { href: string; labelKey: string; external?: boolean };

const PRODUCT_LINKS: FooterLink[] = [
  { href: "/features", labelKey: "features" },
  { href: "/pricing", labelKey: "pricing" },
  { href: "/integrations", labelKey: "integrations" },
  { href: "/industries", labelKey: "industries" },
  { href: "/compare/gohighlevel", labelKey: "vsGohighlevel" },
  { href: "/onboard", labelKey: "getStarted" },
  { href: "/login", labelKey: "signIn" }
];

const COMPANY_LINKS: FooterLink[] = [
  { href: "/about", labelKey: "about" },
  { href: "/blog", labelKey: "blog" },
  { href: "/contact", labelKey: "contact" },
  { href: "/faq", labelKey: "faq" }
];

const LEGAL_LINKS: FooterLink[] = [
  { href: "/privacy", labelKey: "privacy" },
  { href: "/terms", labelKey: "terms" }
];

function FooterColumn({
  title,
  links,
  tNav
}: {
  title: string;
  links: FooterLink[];
  tNav: ReturnType<typeof useTranslations>;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-parchment/40">{title}</p>
      <ul className="mt-3 space-y-2">
        {links.map((l) => (
          <li key={l.labelKey}>
            {l.external ? (
              <a href={l.href} className="text-sm text-parchment/60 transition-colors hover:text-parchment">
                {tNav(l.labelKey)}
              </a>
            ) : (
              <Link href={l.href} className="text-sm text-parchment/60 transition-colors hover:text-parchment">
                {tNav(l.labelKey)}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MarketingFooter() {
  const t = useTranslations("marketing.footer");
  const tNav = useTranslations("marketing.nav");

  return (
    <footer className="border-t border-parchment/10">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-3">
              <Image src="/logo.png" alt={tNav("brand")} width={32} height={32} className="rounded-full" />
              <span className="font-bold tracking-tight text-parchment">{tNav("brand")}</span>
            </div>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-parchment/45">{t("tagline")}</p>
          </div>
          <FooterColumn title={t("product")} links={PRODUCT_LINKS} tNav={tNav} />
          <FooterColumn title={t("company")} links={COMPANY_LINKS} tNav={tNav} />
          <FooterColumn title={t("legal")} links={LEGAL_LINKS} tNav={tNav} />
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t border-parchment/10 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-parchment/30">
            &copy; {new Date().getFullYear()} New Coworker. {t("copyright")}
          </p>
          <a
            href="/llms.txt"
            className="text-xs text-parchment/30 transition-colors hover:text-parchment/60"
          >
            {t("forAi")}
          </a>
        </div>
      </div>
      <SiteChatWidget />
    </footer>
  );
}
