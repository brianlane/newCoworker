import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

type LegalPageProps = {
  eyebrow: string;
  title: string;
  summary: string;
  effectiveDate: string;
  children: ReactNode;
};

/**
 * Shared frame for the legal pages (/terms, /privacy and its subpages, and
 * /security/vulnerability-disclosure): the standard marketing chrome around a
 * single article card. These pages used to carry their own smaller nav and
 * footer; they now render MarketingNav/MarketingFooter like every other
 * public page, which is why they live inside the `(marketing)` route group
 * (its layout provides the client i18n namespaces the shared chrome needs).
 */
export function LegalPage({
  eyebrow,
  title,
  summary,
  effectiveDate,
  children
}: LegalPageProps) {
  const t = useTranslations("marketing.legal");
  const locale = useLocale();
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <main className="mx-auto max-w-4xl px-6 pb-20 pt-8">
        <div className="rounded-3xl border border-parchment/10 bg-parchment/[0.03] p-8 sm:p-12">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-signal-teal">{eyebrow}</p>
          <h1 className="mt-4 font-display text-4xl font-bold tracking-tight sm:text-5xl">{title}</h1>
          <p className="mt-5 max-w-3xl text-base leading-7 text-parchment/70 sm:text-lg">
            {summary}
          </p>
          <p className="mt-6 text-sm text-parchment/45">{t("effectiveDate", { date: effectiveDate })}</p>
          {/* Legal documents are authored (and binding) in English; other
              locales get an explicit notice instead of an unreviewed
              machine translation of contractual language. */}
          {locale !== "en" && (
            <p className="mt-4 rounded-lg border border-signal-teal/20 bg-signal-teal/[0.05] px-4 py-3 text-sm text-parchment/65">
              {t("englishGoverns")}
            </p>
          )}

          <div className="mt-10 space-y-8 text-sm leading-7 text-parchment/78 sm:text-base">
            {children}
          </div>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}

export function LegalSection({
  title,
  children
}: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold text-parchment">{title}</h2>
      <div className="space-y-3 text-parchment/72">
        {children}
      </div>
    </section>
  );
}
