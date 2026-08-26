import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Briefcase, LifeBuoy, Mail, Users } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { ContactForm } from "@/components/marketing/ContactForm";
import { JsonLd } from "@/components/marketing/JsonLd";
import { PageHero } from "@/components/marketing/sections";
import { esAlternates } from "@/lib/i18n/es-routes";
import { SITE_URL } from "@/lib/marketing/site-url";

const CONTACT_PAGE_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "ContactPage",
  name: "Contact New Coworker",
  url: `${SITE_URL}/contact`,
  description:
    "Contact New Coworker for sales, support, white-glove onboarding, and partnerships. Most inquiries receive a response within 24 hours.",
  about: { "@id": `${SITE_URL}/#organization` }
};

// No query-string or session lookups here: topic + signed-in prefill load in
// ContactForm on the client so anonymous scrapes skip Supabase.
export const revalidate = 3600;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.contactPage");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: esAlternates("/contact"),
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: "/contact"
    }
  };
}

const TOPIC_DEFS = [
  { key: "support", Icon: LifeBuoy },
  { key: "enterprise", Icon: Briefcase },
  { key: "whiteGlove", Icon: Users },
  { key: "everythingElse", Icon: Mail }
] as const;

export default async function ContactPage() {
  const t = await getTranslations("marketing.contactPage");

  const topics = TOPIC_DEFS.map(({ key, Icon }) => ({
    title: t(`${key}.title`),
    description: t(`${key}.description`),
    Icon
  }));

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <JsonLd data={CONTACT_PAGE_JSON_LD} />
      <MarketingNav />

      <PageHero
        eyebrow={t("heroEyebrow")}
        title={t("heroTitle")}
        subtitle={t("heroSubtitle")}
      />

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="flex flex-col items-start gap-10 lg:flex-row">
          <div className="min-w-0 flex-1">
            <h2 className="text-3xl font-bold text-parchment">
              {t("formTitle")} <span className="text-claw-green">{t("formTitleHighlight")}</span>
            </h2>
            <p className="mt-4 leading-relaxed text-parchment/60">{t("formBody")}</p>

            <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2">
              {topics.map((topicCard) => (
                <div key={topicCard.title} className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-5">
                  <topicCard.Icon className="mb-3 h-5 w-5 text-claw-green" />
                  <h3 className="text-sm font-semibold text-parchment">{topicCard.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-parchment/50">{topicCard.description}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="w-full flex-shrink-0 lg:max-w-md">
            <ContactForm />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-24 text-center">
        <p className="text-sm text-parchment/45">
          {t.rich("faqPrompt", {
            faq: (chunks: ReactNode) => (
              <Link href="/faq" className="text-signal-teal hover:underline">
                {chunks}
              </Link>
            ),
            pricing: (chunks: ReactNode) => (
              <Link href="/pricing" className="text-signal-teal hover:underline">
                {chunks}
              </Link>
            )
          })}
        </p>
      </section>

      <MarketingFooter />
    </div>
  );
}
