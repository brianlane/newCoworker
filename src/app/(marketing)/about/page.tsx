import type { Metadata } from "next";
import Link from "next/link";
import { Brain, Lock, Server, Sparkles } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { CtaBanner, PageHero, SectionHeading } from "@/components/marketing/sections";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.about");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: { canonical: "/about" },
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: "/about"
    }
  };
}

const PRINCIPLE_DEFS = [
  { key: "privacy", Icon: Lock },
  { key: "employee", Icon: Sparkles },
  { key: "memory", Icon: Brain },
  { key: "stack", Icon: Server }
] as const;

export default async function AboutPage() {
  const t = await getTranslations("marketing.about");

  const principles = PRINCIPLE_DEFS.map(({ key, Icon }) => ({
    title: t(`${key}.title`),
    description: t(`${key}.description`),
    Icon
  }));

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero
        eyebrow={t("heroEyebrow")}
        title={
          <>
            {t("heroTitle")} <span className="text-claw-green">{t("heroHighlight")}</span>
          </>
        }
        subtitle={t("heroSubtitle")}
      />

      <section className="mx-auto max-w-3xl px-6 pb-20">
        <div className="space-y-5 leading-relaxed text-parchment/65">
          <p>{t("storyP1")}</p>
          <p>{t("storyP2")}</p>
          <p>{t("storyP3")}</p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading eyebrow={t("principlesEyebrow")} title={t("principlesTitle")} />
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {principles.map((p) => (
            <div key={p.title} className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-7">
              <p.Icon className="mb-4 h-6 w-6 text-claw-green" />
              <h3 className="font-semibold text-parchment">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-parchment/50">{p.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-24 text-center">
        <p className="text-parchment/55">
          {t("contactPrompt")}{" "}
          <Link href="/contact" className="text-signal-teal hover:underline">
            {t("contactLink")}
          </Link>
          .
        </p>
      </section>

      <CtaBanner
        title={t("ctaTitle")}
        subtitle={t("ctaSubtitle")}
        ctaLabel={t("ctaLabel")}
        ctaHref="/onboard"
      />

      <MarketingFooter />
    </div>
  );
}
