import type { Metadata } from "next";
import Link from "next/link";
import { CalendarCheck, MessageSquareText, PlugZap, Search, ShieldCheck, Trash2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { PageHero, SectionHeading } from "@/components/marketing/sections";
import { esAlternates } from "@/lib/i18n/es-routes";

/**
 * Public documentation for the New Coworker app in ChatGPT. This page is the
 * Documentation URL in the OpenAI plugin listing, so it must keep covering
 * add / use / remove end to end, and it must say plainly what the app can
 * reach (the Slack and Zoom review precedents: a reviewer reads this page
 * before they read anything else).
 *
 * The canonical English URL renders English so reviewers see the reviewed
 * copy; the /es mirror renders Spanish.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.chatgptPage");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: esAlternates("/integrations/chatgpt"),
    openGraph: {
      title: t("metaTitle"),
      description: t("metaDescription"),
      url: "/integrations/chatgpt"
    }
  };
}

/**
 * What the app can reach, by capability rather than by tool name. A reviewer
 * asks "what does this touch", and thirty-odd snake_case tool names answer a
 * different question. Ordered least to most consequential.
 */
const CAPABILITY_COUNT = 6;

export default async function ChatGptIntegrationPage() {
  const t = await getTranslations("marketing.chatgptPage");
  const features = [
    { icon: Search, title: t("featureFindTitle"), body: t("featureFindBody") },
    { icon: MessageSquareText, title: t("featureMessageTitle"), body: t("featureMessageBody") },
    { icon: CalendarCheck, title: t("featureBookTitle"), body: t("featureBookBody") }
  ];
  const steps = [t("step1"), t("step2"), t("step3")];

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero eyebrow={t("heroEyebrow")} title={t("heroTitle")} subtitle={t("heroSubtitle")} />

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <div className="grid gap-6 md:grid-cols-3">
          {features.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-6"
            >
              <Icon className="text-signal-teal" size={22} />
              <h3 className="mt-3 font-semibold text-parchment">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-parchment/60">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-16">
        <SectionHeading eyebrow={t("addEyebrow")} title={t("addTitle")} />
        <ol className="mt-6 space-y-4">
          {steps.map((step, i) => (
            <li
              key={step}
              className="flex gap-4 rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-5"
            >
              <span className="text-sm font-semibold text-claw-green">{i + 1}.</span>
              <span className="text-sm leading-relaxed text-parchment/70">{step}</span>
            </li>
          ))}
        </ol>
        <p className="mt-4 flex items-start gap-2 text-sm text-parchment/50">
          <PlugZap size={16} className="mt-0.5 shrink-0 text-signal-teal" />
          <span>{t("addNote")}</span>
        </p>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-16">
        <SectionHeading eyebrow={t("accessEyebrow")} title={t("accessTitle")} />
        <p className="mt-3 text-sm leading-relaxed text-parchment/60">{t("accessIntro")}</p>
        <ul className="mt-6 space-y-3">
          {Array.from({ length: CAPABILITY_COUNT }, (_, i) => (
            <li
              key={i}
              className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] px-5 py-4 text-sm leading-relaxed text-parchment/70"
            >
              {t(`access${i + 1}`)}
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-16">
        <SectionHeading eyebrow={t("privacyEyebrow")} title={t("privacyTitle")} />
        <div className="mt-4 space-y-3 text-sm leading-relaxed text-parchment/60">
          <p className="flex items-start gap-2">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-signal-teal" />
            <span>{t("privacyRole")}</span>
          </p>
          <p className="flex items-start gap-2">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-signal-teal" />
            <span>{t("privacyNoTraining")}</span>
          </p>
          <p className="flex items-start gap-2">
            <Trash2 size={16} className="mt-0.5 shrink-0 text-signal-teal" />
            <span>{t("privacyRemove")}</span>
          </p>
        </div>
        <p className="mt-6 text-sm text-parchment/50">
          {t("privacyMore")}{" "}
          <Link href="/privacy" className="text-signal-teal underline underline-offset-4">
            {t("privacyLink")}
          </Link>
          .
        </p>
      </section>

      <MarketingFooter />
    </div>
  );
}
