import type { Metadata } from "next";
import Link from "next/link";
import { BellRing, Hash, MessageSquareText, PlugZap, ShieldCheck, Trash2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { PageHero, SectionHeading } from "@/components/marketing/sections";
import { esAlternates } from "@/lib/i18n/es-routes";

/**
 * Public documentation for the "New Coworker" Slack app: how to add, use,
 * and remove the integration. This page is the app's Documentation URL in
 * the Slack Marketplace listing, so it must keep covering add / use /
 * remove end to end (the Zoom page precedent). The canonical English URL
 * renders English so Slack's reviewers see the reviewed copy; the /es
 * mirror renders Spanish.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.slackPage");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: esAlternates("/integrations/slack"),
    openGraph: {
      title: t("metaTitle"),
      description: t("metaDescription"),
      url: "/integrations/slack"
    }
  };
}

/** Scope identifiers are literal API values; only the use column localizes. */
const SCOPE_IDS = [
  "assistant:write",
  "chat:write",
  "chat:write.public",
  "channels:read",
  "groups:read",
  "im:history",
  "app_mentions:read",
  "users:read",
  "users:read.email"
];

export default async function SlackIntegrationPage() {
  const t = await getTranslations("marketing.slackPage");
  const features = [
    { icon: BellRing, title: t("featureAlertsTitle"), body: t("featureAlertsBody") },
    { icon: MessageSquareText, title: t("featureChatTitle"), body: t("featureChatBody") },
    { icon: Hash, title: t("featureApprovalsTitle"), body: t("featureApprovalsBody") }
  ];
  const steps = [t("step1"), t("step2"), t("step3")];

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero eyebrow={t("heroEyebrow")} title={t("heroTitle")} subtitle={t("heroSubtitle")} />

      <section className="mx-auto max-w-3xl px-6 pb-16">
        <SectionHeading eyebrow={t("notesEyebrow")} title={t("notesTitle")} />
        <ul className="mt-2 space-y-3 text-sm leading-relaxed text-parchment/60">
          <li className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-5">{t("noteInaccurate")}</li>
          <li className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-5">{t("notePaidPlan")}</li>
        </ul>
      </section>

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
        <SectionHeading eyebrow={t("scopesEyebrow")} title={t("scopesTitle")} />
        <p className="mt-3 text-sm leading-relaxed text-parchment/60">{t("scopesIntro")}</p>
        <div className="mt-6 overflow-x-auto rounded-2xl border border-parchment/10">
          <table className="w-full text-left text-sm">
            <thead className="bg-parchment/[0.04] text-parchment/70">
              <tr>
                <th className="px-4 py-3 font-semibold">{t("scopeColId")}</th>
                <th className="px-4 py-3 font-semibold">{t("scopeColUse")}</th>
              </tr>
            </thead>
            <tbody className="text-parchment/60">
              {SCOPE_IDS.map((id, i) => (
                <tr key={id} className="border-t border-parchment/10">
                  <td className="px-4 py-3 font-mono text-xs text-parchment/80">{id}</td>
                  <td className="px-4 py-3">{t(`scopeUse${i + 1}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-16">
        <SectionHeading eyebrow={t("privacyEyebrow")} title={t("privacyTitle")} />
        <div className="mt-4 space-y-3 text-sm leading-relaxed text-parchment/60">
          <p className="flex items-start gap-2">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-signal-teal" />
            <span>{t("privacyStored")}</span>
          </p>
          <p>{t("privacyMessages")}</p>
          <p>
            {t("privacyPolicyLead")}{" "}
            <Link href="/privacy" className="text-signal-teal underline hover:text-parchment">
              {t("privacyPolicyLink")}
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-24">
        <SectionHeading eyebrow={t("removeEyebrow")} title={t("removeTitle")} />
        <p className="mt-4 flex items-start gap-2 text-sm leading-relaxed text-parchment/60">
          <Trash2 size={16} className="mt-0.5 shrink-0 text-signal-teal" />
          <span>{t("removeBody")}</span>
        </p>
        <p className="mt-4 text-sm text-parchment/50">
          {t("supportLead")}{" "}
          <Link href="/contact" className="text-signal-teal underline hover:text-parchment">
            {t("supportLink")}
          </Link>
          .
        </p>
      </section>

      <MarketingFooter />
    </div>
  );
}
