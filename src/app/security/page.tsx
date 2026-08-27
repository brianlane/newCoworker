import type { Metadata } from "next";
import Link from "next/link";
import { FileSearch, Lock, ServerCog } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { SectionMessages } from "@/components/i18n/SectionMessages";
import { CtaBanner, PageHero } from "@/components/marketing/sections";

/**
 * Buyer-facing security posture page. The copy is the marketing-safe
 * synthesis of the README's "Security: posture summary (buyer-facing)"
 * section, which is kept in lockstep with the code; nothing here may
 * overstate what ships. It lives beside /security/vulnerability-disclosure
 * (outside the (marketing) route group), so it wraps itself in the
 * marketing SectionMessages boundary the group would otherwise provide.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.securityPage");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical: "/security" },
    openGraph: {
      title: t("ogTitle"),
      description: t("metaDescription"),
      url: "/security"
    }
  };
}

const SECTION_DEFS = [
  { key: "s1", Icon: ServerCog },
  { key: "s2", Icon: Lock },
  { key: "s3", Icon: FileSearch }
] as const;

export default async function SecurityPage() {
  const t = await getTranslations("marketing.securityPage");

  return (
    <SectionMessages section="marketing">
      <div className="min-h-screen bg-deep-ink text-parchment">
        <MarketingNav />

        <PageHero
          eyebrow={t("heroEyebrow")}
          title={t("heroTitle")}
          subtitle={t("heroSubtitle")}
        />

        <section className="mx-auto max-w-4xl space-y-6 px-6 pb-16">
          {SECTION_DEFS.map(({ key, Icon }) => (
            <article
              key={key}
              className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-8"
            >
              <div className="mb-4 flex items-center gap-3">
                <Icon className="h-5 w-5 shrink-0 text-claw-green" aria-hidden />
                <h2 className="text-xl font-bold text-parchment">{t(`${key}Title`)}</h2>
              </div>
              <p className="text-sm leading-relaxed text-parchment/65">{t(`${key}Body1`)}</p>
              <p className="mt-4 text-sm leading-relaxed text-parchment/65">{t(`${key}Body2`)}</p>
            </article>
          ))}

          <div className="rounded-2xl border border-signal-teal/20 bg-signal-teal/[0.04] p-8">
            <h2 className="text-lg font-bold text-parchment">{t("vdpTitle")}</h2>
            <p className="mt-2 text-sm leading-relaxed text-parchment/65">{t("vdpBody")}</p>
            <Link
              href="/security/vulnerability-disclosure"
              className="mt-4 inline-block text-sm font-semibold text-signal-teal hover:underline"
            >
              {t("vdpLink")}
            </Link>
          </div>
        </section>

        <CtaBanner
          title={t("ctaTitle")}
          subtitle={t("ctaSubtitle")}
          ctaLabel={t("ctaLabel")}
          ctaHref="/contact?topic=enterprise"
        />

        <MarketingFooter />
      </div>
    </SectionMessages>
  );
}
